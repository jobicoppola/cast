/*
 * Licensed to Cloudkick, Inc ('Cloudkick') under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * Cloudkick licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var sys = require('sys');
var path = require('path');
var constants = require('constants');

var log = require('util/log');
var config = require('util/config');
var http = require('util/http');
var tailFile = require('util/tail').tailFile;
var serviceManagement = require('service_management');
var route = require('services/http').route;

function listServices(req, res) {
  var manager = serviceManagement.getDefaultManager().getManager();

  manager.listServicesDetails(function(err, services) {
    if (err) {
      http.returnError(res, 500, err);
      return;
    }
    http.returnJson(res, 200, services);
  });
}

function getService(req, res) {
  var service = req.params.service;
  var manager = serviceManagement.getDefaultManager().getManager();

  manager.getService(service, function(err, svc) {
    if (err) {
      http.returnError(res, 404, err, 'Service does not exist');
      return;
    }

    svc.getDetails(function(err, details) {
      if (err) {
        http.returnError(res, 500, err);
        return;
      }

      http.returnJson(res, 200, details);
    });
  });
}

function tailService(req, res) {
  var service = req.params.service;
  var bytesToRead = req.params.bytesToRead;
  var logFile;
  var manager = serviceManagement.getDefaultManager().getManager();

  manager.getService(service, function(err, svc) {
    if (err) {
      http.returnError(res, 404, err, 'Service not found');
      return;
    }

    logFile = svc.getLogPath();
    tailFile(logFile, bytesToRead, false, function(err, data, unsubscribe) {
      if (err) {
        http.returnError(res, 500, err);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(data);
    });
  });
}

function tailFollowService(req, res) {
  var service = req.params.service;
  var bytesToRead = req.params.bytesToRead;
  var logFile;
  var headWritten = false;
  var listenersSet = false;
  var manager = serviceManagement.getDefaultManager().getManager();

  manager.getService(service, function(err, svc) {
    if (err) {
      http.returnError(res, 404, err, 'Service not found');
      return;
    }

    res.connection.setTimeout(0);

    logFile = svc.getLogPath();
    tailFile(logFile, bytesToRead, true, function(err, data, unsubscribe) {
      if (err) {
        http.returnError(res, bytesToRead, err);
        return;
      }

      if (!headWritten) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Connection': 'keep-alive' });
        headWritten = true;
      }

      res.write(data);

      if (!listenersSet) {
        res.on('error', unsubscribe);
        req.on('error', unsubscribe);
        req.connection.on('end', unsubscribe);

        listenersSet = true;
      }
    });
  });
}

function actionService(req, res, action, serviceName) {
  var statusCode, errMessage;
  var manager = serviceManagement.getDefaultManager().getManager();

  manager.runAction(serviceName, action, function(err) {
    if (err) {
      if (err.errno === constants.ENOENT) {
        statusCode = 404;
        errMessage = 'Service does not exist';
      }
      else {
        statusCode = 500;
        errMessage = err.message;
      }

      http.returnError(res, statusCode, err, errMessage);
      return;
    }

    http.returnJson(res, 200, {
      'service': serviceName,
      'method': action,
      'result': 'success'
    });
  });
}

function enableService(req, res) {
  var service = req.params.service;
  actionService(req, res, 'enable', service);
}

function disableService(req, res) {
  var service = req.params.service;
  actionService(req, res, 'disable', service);
}

function startService(req, res) {
  var service = req.params.service;
  actionService(req, res, 'start', service);
}

function stopService(req, res) {
  var service = req.params.service;
  actionService(req, res, 'stop', service);
}

function restartService(req, res) {
  var service = req.params.service;
  actionService(req, res, 'restart', service);
}

function register(app, apiVersion) {
  // @TODO: verify bytesToRead is Number
  app.get('/', listServices);
  app.get('/:service/', getService);
  app.get('/:service/tail/:bytesToRead/', tailService);
  app.get('/:service/tail/:bytesToRead/follow/', tailFollowService);
  app.put('/:service/enable/', enableService);
  app.put('/:service/disable/', disableService);
  app.put('/:service/start/', startService);
  app.put('/:service/stop/', stopService);
  app.put('/:service/restart/', restartService);
}

exports.register = register;
