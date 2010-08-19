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

/**
 * The mkdir and rm-rf implementations are based on the ones in NPM:
 *   <http://github.com/isaacs/npm/blob/master/lib/utils/mkdir-p.js>
 *   <http://github.com/isaacs/npm/blob/master/lib/utils/rm-rf.js>
 *
 * Copyright 2009, 2010 Isaac Zimmitti Schlueter. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

var fs = require("fs");
var path = require("path");

/**
 * Recursively create a directory.
 *
 * @param {String} ensure  The path to recursively create.
 * @param {number} chmod  File permissions to use when creating directories
 * @param {Function} cb     Callback, taking a possible error
 */
exports.mkdir = function (ensure, chmod, cb)
{
  if (ensure.charAt(0) !== "/") {
    ensure = path.join(process.cwd(), ensure);
  }

  var dirs = ensure.split("/");
  var walker = [];

  if (arguments.length < 3) {
    cb = chmod;
    chmod = 0755;
  }

  // gobble the "/" first
  walker.push(dirs.shift());

  (function S (d) {

    if (d === undefined) {
      return cb();
    }

    walker.push(d);
    var dir = walker.join("/");

    fs.stat(dir, function (er, s) {

      if (er) {
        fs.mkdir(dir, chmod, function (er, s) {
          if (er) {
            return cb(new Error("Failed to make "+dir+" while ensuring "+ensure+"\n"+er.message));
          }
          S(dirs.shift());
        });
      }
      else {
        if (s.isDirectory()) {
          S(dirs.shift());
        }
        else {
          cb(new Error("Failed to mkdir "+dir+": File exists"));
        }
      }
    });
  })(dirs.shift());
};


function rmtree_(p, cb_, error_context) {
  if (!p) {
    return cb_(new Error("Trying to rm nothing?"));
  }

  if (error_context === undefined) {
    error_context = {};
    error_context.has_error = false;
  }

  function cb(err) {
    if (err) {
      error_context.has_error = true;
    }
    cb_(err);
  }

  fs.lstat(p, function (er, s) {
    if (error_context.has_error) {
      return;
    }

    if (er) {
      return cb(new Error('Failed to lstat: '+ er));
    }

    if (s.isDirectory()) {
      fs.readdir(p, function (er, files) {
        if (error_context.has_error) {
          return;
        }

        if (er) {
          return cb(er);
        }

        var count = files.length;
        var n = 0;
        function dirdone(err) {
          if (error_context.has_error) {
            return;
          }
          if (err) {
            cb(err);
          }
          else {
            n++;
            if (n >= count) {
              fs.rmdir(p, function(err) {
                if (error_context.has_error) {
                  return;
                }
                if (err) {
                  cb(err);
                }
                cb();
              });
            }
          }
        }

        if (count === 0) {
          dirdone();
        }
        else {
          files.forEach(function(file) {
            if (error_context.has_error) {
              return;
            }
            rmtree_(path.join(p, file), dirdone, error_context);
          });
        }
      });
    }
    else {
      fs.unlink(p, function(er) {
        if (error_context.has_error) {
          return;
        }

        if (er) {
          return cb(er);
        }

        cb();
      });
    }
  });
}

/**
 * Deletes an entire tree off the filesystem, first removing all files,
 * and then deleting the directories.
 *
 * @param {String} p  The path to recursively delete.
 * @param {Function} cb_     Callback on finish, taking a possible error
 */
exports.rmtree = function(p, cb_) {
  return rmtree_(p, cb_);
};