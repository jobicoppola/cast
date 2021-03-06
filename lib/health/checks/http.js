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
var http = require('http');
var https = require('https');
var url = require('url');

var sprintf = require('sprintf').sprintf;

var log = require('util/log');

var Check = require('health').Check;
var CheckResult = require('health').CheckResult;
var CheckStatus = require('health').CheckStatus;

var config = {
  name: 'HTTP check',
  requiredArguments: ['url', 'type', 'match_value'],
  optionalArguments: [],
  defaultValues: {},
  types: {
    STATUS_CODE_MATCH: 0,
    BODY_REGEX_MATCH: 1
  }
};

/**
 * HTTP(s) check.
 *
 * @param {Object} checkArguments Provided check arguments.
 *
 * @constructor
 */
function HTTPCheck(checkArguments) {
  Check.call(this, config.name, config.requiredArguments,
             config.optionalArguments, config.defaultValues, checkArguments);
}

// Inherit from the base Check class
sys.inherits(HTTPCheck, Check);

HTTPCheck.prototype.run = function(callback) {
  // @TODO: Don't use http and add support for timeout
  var method;
  var self = this;
  log.info(sprintf('Running HTTP check (URL: %s, type: %s, match_value: %s)',
           this.checkArguments.url,
           this.checkArguments.type,
           this.checkArguments['match_value']));

  var result = new CheckResult();
  var timeout = false;

  var options = {
    'host': self.checkArguments.host,
    'port': parseInt(self.checkArguments.port, 10),
    'method': 'GET',
    'path': self.checkArguments.path
  };

  method = (self.checkArguments.secure) ? https.request : http.request;

  var req = method(options, function onResponse(response) {
    if (self.checkArguments.type === config.types.STATUS_CODE_MATCH) {
      var statusCode = response.statusCode;

      if (statusCode === self.checkArguments['match_value']) {
        result.status = CheckStatus.SUCCESS;
        result.details = sprintf('Returned status code: %s', statusCode);
      }
      else {
        result.status = CheckStatus.ERROR;
        result.details = sprintf('Returned status code:  %s', statusCode);
      }

      self.addResult(result, callback);
    }
    else if (self.checkArguments.type === config.types.BODY_REGEX_MATCH) {
      // We only care about the content if it's a body regex match check
      var dataBuffer = [];

      response.on('data', function(chunk) {
        dataBuffer.push(chunk);
      });

      response.on('end', function() {
        var body = dataBuffer.join('');

        if (body.match(self.checkArguments['match_value'])) {
          result.status = CheckStatus.SUCCESS;
          result.details = sprintf('The response body matched the regular expression: %s',
                                  self.checkArguments['match_value'].toString());
        }
        else {
          result.status = CheckStatus.ERROR;
          result.details = sprintf('The response body didn\'t match the regular expression: %s',
                                   self.checkArguments['match_value'].toString());
        }

        self.addResult(result, callback);
      });
    }
  });

  function errorHandler(exception) {
    result.status = CheckStatus.ERROR;
    result.details = sprintf('Check failed - returned exception: %s', exception);

    self.addResult(result, callback);
  }

  // Register generic error event handlers
  req.on('error', errorHandler);

  // Send the request
  req.end();
};

HTTPCheck.prototype.formatArguments = function(requiredArguments, optionalArguments,
                                                defaultValues, checkArguments) {
  var formattedArguments = Check.prototype.formatArguments.call(this, requiredArguments,
                                          optionalArguments, defaultValues,
                                          checkArguments);

  var urlObject = url.parse(formattedArguments.url);

  formattedArguments.host = urlObject.hostname;
  formattedArguments.path = urlObject.pathname || '/';

  formattedArguments.secure = (urlObject.protocol === 'https:') || false;
  formattedArguments.port = urlObject.port || (formattedArguments.secure === true ? 443 : 80);

  if (formattedArguments.type === config.types.STATUS_CODE_MATCH) {
    formattedArguments['match_value'] = parseInt(formattedArguments['match_value'], 10);
  }
  else if (checkArguments.type === config.types.BODY_REGEX_MATCH) {
    formattedArguments['match_value'] = new RegExp(formattedArguments['match_value']);
  }
  else {
    throw new Error(sprintf('Invalid check type: %s', formattedArguments.type));
  }

  return formattedArguments;
};

exports.config = config;
exports.HTTPCheck = HTTPCheck;
