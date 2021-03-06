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

var querystring = require('querystring');

var async = require('async');

var deployment = require('deployment');
var http = require('util/http');
var requiredParams = require('http/middleware/required-params').attachMiddleware;

var INSTANCE_NAME_RE = /^[a-zA-Z0-9_\-]+$/;

/**
 * Given an Instance object, generate an object in a format appropriate for
 * returning via the JSON api.
 *
 * @param {Instance} instance The instance to format.
 * @param {Function} callback A callback taking (err, data).
 */
function formatInstance(instance, callback) {
  var bundleVersion, bundleName;

  // Look up the name and version of each instance
  async.parallel([
    function(callback) {
      instance.getBundleName(function(err, name) {
        bundleName = name;
        callback(err);
        return;
      });
    },

    function(callback) {
      instance.getBundleVersion(function(err, version) {
        if (err) {
          callback(err);
          return;
        }

        bundleVersion = version;
        callback();
        return;
      });
    }
  ],

  function(err) {
    if (err) {
      callback(err);
      return;
    }

    callback(null, {
      'name': instance.name,
      'bundle_name': bundleName,
      'bundle_version': bundleVersion
    });
    return;
  });
}

function listInstances(req, res) {
  deployment.getInstanceList(function(err, instances) {
    if (err) {
      return http.returnError(res, 500, err);
    }

    // Format each instance
    async.map(instances, formatInstance, function(err, instanceList) {
      if (err) {
        return http.returnError(res, 500, err);
      }

      // Sort by name
      instanceList.sort(function(a, b) {
        return (b.name < a.name);
      });

      http.returnJson(res, 200, instanceList);
    });
  });
}

function getInstance(req, res) {
  var instanceName = req.params.instanceName;

  deployment.getInstance(instanceName, function(err, instance) {
    if (err) {
      return http.returnError(res, 404, err, 'No such instance');
    }
    formatInstance(instance, function(err, instanceData) {
      if (err) {
        return http.returnError(res, 500, err);
      }
      http.returnJson(res, 200, instanceData);
    });
  });
}

function createInstance(req, res) {
  var instanceName = req.params.instanceName;
  var params = req.body;
  var bundleName = params.bundle_name;
  var bundleVersion = params.bundle_version;
  var enableService = params.enable_service;

  deployment.createInstance(instanceName, bundleName, bundleVersion,
                            enableService, function(err) {
    if (err) {
      http.returnError(res, 500, err);
    }
    else {
      http.returnJson(res, 200, {
        'result': 'success'
      });
    }
  });
}

function upgradeInstance(req, res) {
  var instanceName = req.params.instanceName;
  var params = req.body;
  var bundleVersion = params.bundle_version;

  deployment.upgradeInstance(instanceName, bundleVersion, function(err) {
    if (err) {
      http.returnError(res, 500, err);
    }
    else {
      http.returnJson(res, 200, {
        'result': 'success'
      });
    }
  });
}

function destroyInstance(req, res) {
  var instanceName = req.params.instanceName;

  deployment.getInstance(instanceName, function(err, instance) {
    if (err) {
      return http.returnError(res, 404, err, 'No such instance');
    }
    instance.destroy(function() {
      http.returnJson(res, 200, {
        'result': 'success'
      });
    });
  });
}

function register(app, apiVersion) {
  app.get('/', listInstances);
  app.get('/:instanceName/', getInstance);
  app.put('/:instanceName/', requiredParams(['bundle_name', 'bundle_version']), createInstance);
  app.post('/:instanceName/upgrade/', requiredParams(['bundle_version']), upgradeInstance);
  app.del('/:instanceName/', destroyInstance);
}

exports.register = register;
