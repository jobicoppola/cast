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

var fs = require('fs');
var path = require('path');

var async = require('async');
var sprintf = require('sprintf').sprintf;

var hooks = require('deployment/hooks');
var deployTemplates = require('deployment/templates');
var deployServices = require('deployment/services');
var deployFiles = require('deployment/files');
var deployConstants = require('deployment/constants');

var serviceManagement = require('service_management');
var manifest = require('manifest');
var manifestConstants = require('manifest/constants');
var config = require('util/config');
var fsutil = require('util/fs');
var flowctrl = require('util/flow_control');
var misc = require('util/misc');

var Errorf = misc.Errorf;

/**
 * Represents an instance.
 * @constructor
 *
 * @param {String} name Instance name.
 */
function Instance(name) {
  this.name = name;
  this.root = path.join(config.get()['app_dir'], name);
  this._bundleName = null;
}

/**
 * Check if an instance exists
 *
 * @param {String} instanceName The name of the instance.
 * @param {Function} callback Callback which is called with a boolean 'exists'.
 */
Instance.prototype.exists = function(callback) {
  fs.stat(this.root, function(err, stats) {
    if (!err && stats.isDirectory()) {
      callback(true);
      return;
    }

    callback(false);
    return;
  });
};

/**
 * Get the name of the bundle used by an instance. This is probably the
 * nastiest part of this whole instance filesystem layout because it requires
 * reading a link. To keep things fast this gets cached on the Instance object.
 *
 * @param {Function} callback Callback which is called with (err, bundleName).
 */
Instance.prototype.getBundleName = function(callback) {
  var self = this;
  if (self._bundleName) {
    process.nextTick(function() {
      callback(null, self._bundleName);
    });
  }
  else {
    var bundleLinkPath = path.join(self.root, 'bundle');
    fs.readlink(bundleLinkPath, function(err, target) {
      if (!err) {
        self._bundleName = path.basename(target);
      }
      callback(err, self._bundleName);
      return;
    });
  }
};

/**
 * Get the version pointed to by the 'current' link.
 *
 * @param {Function} callback Callback which is called with (err, version).
 */
Instance.prototype.getBundleVersion = function(callback) {
  var self = this;
  var currentLinkPath = path.join(self.root, 'current');
  fs.readlink(currentLinkPath, function(err, target) {
    if (err) {
      callback(err);
      return;
    }
    else {
      callback(null, target.split('@', 2)[1]);
      return;
    }
  });
};

/**
 * Get the path at which a version of this instance would reside. This does
 * not guarantee that this version exists, merely returns the hypothetical
 * path at which it would reside.
 *
 * @param {String} version    The version to get the path to.
 * @param {Function} callback A callback that takes (err, versionPath).
 */
Instance.prototype.getVersionPath = function(version, callback) {
  var self = this;
  self.getBundleName(function(err, bundleName) {
    var bundleNameFull = misc.getFullBundleName(bundleName, version);
    var versionPath = path.join(self.root, 'versions', bundleNameFull);
    callback(err, versionPath);
    return;
  });
};

/**
 * Get the path at which the extracted bundle for the specified version would
 * reside. Again, this doesn't verify that the path actually exists.
 *
 * @param {String} version    The version to get the path to.
 * @param {Function} callback A callback that takes (err, bundleVersionPath).
 */
Instance.prototype.getBundleVersionPath = function(version, callback) {
  this.getBundleName(function(err, bundleName) {
    var bundleNameFull = misc.getFullBundleName(bundleName, version);
    var bundleVersionPath = path.join(config.get()['extracted_dir'], bundleName, bundleNameFull);
    callback(err, bundleVersionPath);
    return;
  });
};

/**
 * Remove all data related to an instance, including the instance, its data,
 * and any services. This performs very little validation (doesn't even check
 * that the instance exists first), it just starts deleting stuff.
 *
 * @param {Function} callback Callback which is called when the cleanup process has finished.
 */
Instance.prototype.destroy = function(callback) {
  var self = this;

  function getBundleVersion(callback) {
    self.getBundleVersion(callback);
  }

  function destroyService(bundleVersion, callback) {
    var manager = serviceManagement.getDefaultManager().getManager();
    var serviceName = sprintf('%s@%s', self.name, bundleVersion);

    function whenServiceDestroyed() {
      callback(null, bundleVersion);
    }

    flowctrl.callIgnoringError(manager.runAction, manager, serviceName, 'destroy',
                               whenServiceDestroyed);
  }

  function removeInstanceDirectory(bundleVersion, callback) {
    flowctrl.callIgnoringError(fsutil.rmtree, null, self.root, function(err) {
      callback(null, bundleVersion);
    });
  }

  var ops = [getBundleVersion, destroyService, removeInstanceDirectory];

  async.waterfall(ops, function(err) {
    callback();
  });
};

/**
 * Upgrade an instance to a new version.
 *
 * @param {String} bundleVersion Version of the bundle to which the instance
 *                               will be upgraded.
 * @param {Function} callback    Callback which is called with (err).
 */
Instance.prototype.upgrade = function(bundleVersion, callback) {
  var self = this;

  var bundleName, bundleNameFull, extractedBundleRoot, extractedBundlePath;
  var newInstanceVersionPath, oldServiceName, manifestObj, oldBundleVersionPath;
  var oldBundleNameFull;
  var instancePath = path.join(config.get()['app_dir'], this.name);
  var instanceVersionsRoot = path.join(instancePath, 'versions');
  var serviceName = sprintf('%s@%s', this.name, bundleVersion);

  var previousVersionLink = path.join(self.root, 'previous');

  var manager = serviceManagement.getDefaultManager().getManager();

  // Get currently active bundle name and populate some variables
  function getBundleName(callback) {
    self.getBundleName(function(err, _bundleName) {
      if (err) {
        callback(err);
        return;
      }

      bundleName = _bundleName;

      bundleNameFull = misc.getFullBundleName(bundleName, bundleVersion);
      extractedBundleRoot = path.join(config.get()['extracted_dir'], bundleName);
      extractedBundlePath = path.join(extractedBundleRoot, bundleNameFull);
      newInstanceVersionPath = path.join(instanceVersionsRoot, bundleNameFull);
      callback();
    });
  }

  // Get the currently active bundle version
  function getBundleVersion(callback) {
    self.getBundleVersion(function(err, version) {
      if (err) {
        callback(err);
        return;
      }

      oldServiceName = misc.getFullBundleName(self.name, version);
      oldBundleNameFull = misc.getFullBundleName(bundleName, version);
      oldBundleVersionPath = path.join(self.root, 'versions', oldBundleNameFull);
      callback();
    });
  }

  // Prepare a new version
  function prepareVersion(callback) {
    self.prepareVersion(bundleVersion, callback);
  }

  // Retrieve the manifest object
  function retrieveManifestObject(callback) {
    var manifestPath = path.join(extractedBundlePath, manifestConstants.MANIFEST_FILENAME);
    manifest.getManifestObject(manifestPath, true, function(err, _manifestObj) {
      manifestObj = _manifestObj;
      callback(err);
    });
  }

  // Create a new service for this version
  function createNewService(callback) {
    deployServices.createService(serviceName, newInstanceVersionPath, manifestObj, callback);
  }

  // Activate a new version
  function activateNewVersion(callback) {
    self.activateVersion(bundleVersion, callback);
  }

  // Disable the old service
  function disableOldService(callback) {
    flowctrl.callIgnoringError(manager.runAction, manager, oldServiceName,
                               'disable', callback);
  }

  // Enable and start the new service
  function startNewService(callback) {
    deployServices.enableAndStartService(serviceName, callback);
  }

  // Create a previous symlink which points to the previous version bundle
  function symlinkOldToPrevious(callback) {
    function createSymlink() {
      fs.symlink(oldBundleVersionPath, previousVersionLink, callback);
    }

    flowctrl.callIgnoringError(fs.unlink, null, previousVersionLink, createSymlink);
  }

  function destroyOldService(callback) {
    // TODO: Do a rollback if a new service is still reported as down after x
    // milliseconds.
    manager.runAction(oldServiceName, 'destroy', callback);
  }

  var ops = [getBundleName, getBundleVersion, prepareVersion,
             retrieveManifestObject, createNewService, activateNewVersion,
             disableOldService, startNewService, symlinkOldToPrevious,
             destroyOldService];

  async.series(ops, function(err) {
    callback(err);
  });
};

Instance.prototype.rollback = function() {
  // stub.
};

/**
 * Given a bundle version, hard hard link all the files into place, render
 * any templates and resolve all data files.
 *
 * @param {String} version    The version of the bundle to prepare.
 * @param {Function} callback A callback fired with (err).
 */
Instance.prototype.prepareVersion = function(version, callback) {
  var self = this;
  var extractedBundlePath, bundleName, bundleNameFull, manifestObj;
  var instanceVersionPath, ignoredPaths;

  var bundleLinkPath = path.join(self.root, 'bundle');
  var hookEnv = { 'CAST_INSTANCE_NAME': self.name };

  async.series([
    // Resolve the path at which the version will reside
    function(callback) {
      self.getVersionPath(version, function(err, vp) {
        instanceVersionPath = vp;
        callback(err);
        return;
      });
    },

    // Resolve the path to the extracted bundle
    function(callback) {
      self.getBundleVersionPath(version, function(err, bvp) {
        extractedBundlePath = bvp;
        callback(err);
        return;
      });
    },

    // Make sure this version doesn't exist
    function(callback) {
      path.exists(instanceVersionPath, function(exists) {
        var err = null;
        if (exists) {
          err = new Errorf('Instance \'%s\' already has version \'%s\'', self.name, version);
        }
        callback(err);
        return;
      });
    },

    // Make sure an extracted bundle exists for the requested version
    function(callback) {
      fs.stat(extractedBundlePath, function(err, stats) {
        if (!err && !stats.isDirectory()) {
          err = new Errorf('No bundle for version \'%s\'', version);
        }
        callback(err);
        return;
      });
    },

    // Create the directory for the target version
    function(callback) {
      fsutil.ensureDirectory(instanceVersionPath, callback);
    },

    // Retrieve the manifest object
    function(callback) {
      var manifestPath = path.join(extractedBundlePath, manifestConstants.MANIFEST_FILENAME);
      manifest.getManifestObject(manifestPath, true, function(err, _manifestObj) {
        manifestObj = _manifestObj;
        ignoredPaths = manifestObj['template_files'].concat(manifestObj['data_files']);
        callback(err);
        return;
      });
    },

    // Mirror the directory structure from the extracted bundle in the instance directory
    function(callback) {
      fsutil.treeToTemplate(extractedBundlePath, ignoredPaths, function(err, templateObject) {
        if (err) {
          callback(err);
          return;
        }

        // No directories
        if (Object.keys(templateObject).length === 0) {
          callback();
          return;
        }

        fsutil.templateToTree(instanceVersionPath, templateObject, true, callback);
      });
    },

    // Realize (render and save) templates
    function(callback) {
      var instanceData = deployTemplates.getInstanceTemplateObject(self.name,
                                                                   instanceVersionPath,
                                                                    version);
      deployTemplates.realizeApplicationTemplates(manifestObj, instanceData, extractedBundlePath,
                                                     instanceVersionPath, callback);
    },

    // Hard-link all the files (except template and data files)
    function(callback) {
      fsutil.hardLinkFiles(extractedBundlePath, instanceVersionPath, ignoredPaths, callback);
    },

    // Resolve the data files
    function(callback) {
      var instanceDataRoot = path.join(self.root, 'data');
      deployFiles.resolveDataFiles(extractedBundlePath, instanceDataRoot, instanceVersionPath,
                                   manifestObj['data_files'], callback);
    },

    // Execute the 'post_prepare' hook
    function(callback) {
      var hook = new hooks.InstanceHook('post', 'post_prepare',
                                        instanceVersionPath, false, hookEnv);
      hook.execute(null, [version], callback);
    }
  ], callback);
};

/**
 * Point the 'current' symlink to the specified version. Will verify
 * that the specified version exists before taking action.
 *
 * @param {String} version    The version to activate.
 * @param {Function} callback A callback fired with (err).
 */
Instance.prototype.activateVersion = function(version, callback) {
  var self = this;
  var newVersionPath;

  var newVersionLink = path.join(self.root, 'new');
  var currentVersionLink = path.join(self.root, 'current');
  var hookEnv = { 'CAST_INSTANCE_NAME': self.name };

  async.series([
    // Get the path to the specified version
    function(callback) {
      self.getVersionPath(version, function(err, vp) {
        newVersionPath = vp;
        callback(err);
        return;
      });
    },

    // Make sure the version exists
    function(callback) {
      path.exists(newVersionPath, function(exists) {
        var err = null;
        if (!exists) {
          err = new Errorf('Cannot activate nonexistent version \'%s\'', version);
        }

        callback(err);
        return;
      });
    },

    function(callback) {
      var hook = new hooks.InstanceHook('post', 'pre_version_activate',
                                        newVersionPath, false, hookEnv);
      hook.execute(null, [version, newVersionPath], callback);
    },

    // Create the new link
    function(callback) {
      fs.symlink(path.resolve(newVersionPath), newVersionLink, callback);
    },

    // Atomically move it into place
    async.apply(fs.rename, newVersionLink, currentVersionLink),

    function(callback) {
      var hook = new hooks.InstanceHook('post', 'post_version_activate',
                                        newVersionPath, false, hookEnv);
      hook.execute(null, [version, newVersionPath], callback);
    }
  ], callback);
};

/**
 * Get an Instance object for an instance whose existence is verified.
 *
 * @param {String} instanceName  The name of the instance to retrieve.
 * @param {Function} callback     A callback that takes (err, instance).
 */
function getInstance(instanceName, callback) {
  var instance = new Instance(instanceName);
  instance.exists(function(exists) {
    if (!exists) {
      callback(new Errorf('Instance "%s" doesn\'t exist', instanceName));
      return;
    }
    else {
      callback(null, instance);
      return;
    }
  });
}

/**
 * Get a list of all instances (in the form of Instance objects).
 *
 * @param {Function} callback A callback that takes (err, instances).
 */
function getInstanceList(callback) {
  fs.readdir(config.get()['app_dir'], function(err, files) {
    if (err) {
      callback(err);
      return;
    }

    // Construct an Instance for each file in the app_dir
    var instanceList = files.map(function(file) {
      return new Instance(file);
    });

    // Make sure each instance actually exists (ie, isn't a non-directory of some sort)
    async.filter(instanceList, function(instance, callback) {
      instance.exists(callback);
    },
    function(instances) {
      callback(null, instances);
      return;
    });
  });
}

/**
 * Create an instance with a specified name for the specified bundle. The
 * instance will initially use the specified version of the bundle.
 *
 * @param {String} instanceName  A name to give to the instance.
 * @param {String} bundleName    The name of the bundle to use.
 * @param {String} bundleVersion The version of the bundle to use.
 * @param {String} enableService True to enable and start the service after the
 *                               instance has been created.
 * @param {Function} callback    A callback fired with (err).
 */
function createInstance(instanceName, bundleName, bundleVersion, enableService,
                        callback) {
  if (!deployConstants.INSTANCE_NAME_RE.exec(instanceName)) {
    callback(new Error('Invalid instance name'));
    return;
  }

  var manifestObj, ignoredPaths, instance;
  var bundleNameFull = misc.getFullBundleName(bundleName, bundleVersion);

  // Get the paths to the extracted bundle and the manifest
  var extractedBundleRoot = path.join(config.get()['extracted_dir'], bundleName);
  var extractedBundlePath = path.join(extractedBundleRoot, bundleNameFull);

  var manager = serviceManagement.getDefaultManager().getManager();

  var instancePath = path.join(config.get()['app_dir'], instanceName);
  var instanceDataRoot = path.join(instancePath, 'data');
  var instanceVersionsRoot = path.join(instancePath, 'versions');
  var instanceBundleLink = path.join(instancePath, 'bundle');
  var instanceCurrentLink = path.join(instancePath, 'current');
  var instanceVersionPath = path.join(instanceVersionsRoot, bundleNameFull);
  var serviceName = sprintf('%s@%s', instanceName, bundleVersion);

  async.series([
    // Make sure that the extracted bundle path exists
    function(callback) {
      path.exists(extractedBundlePath, function(exists) {
        if (!exists) {
          callback(new Error('Invalid bundle name or version'));
          return;
        }

        callback();
      });
    },

    // Make sure there isn't already an instance with this name
    function(callback) {
      path.exists(instancePath, function(exists) {
        if (exists) {
          callback(new Error('Instance name already in use'));
          return;
        }
        callback();
      });
    },

    // Create the instance directory
    function(callback) {
      fsutil.ensureDirectory(instancePath, function(err) {
        if (!err) {
          instance = new Instance(instanceName);
        }
        callback(err);
      });
    },

    // Create the data and versions directories
    async.apply(fsutil.ensureDirectory, instanceDataRoot),
    async.apply(fsutil.ensureDirectory, instanceVersionsRoot),

    // Create the bundle symlink
    async.apply(fs.symlink, path.resolve(extractedBundleRoot), instanceBundleLink),

    // Prepare the specified version
    function(callback) {
      instance.prepareVersion(bundleVersion, callback);
    },

    // Retrieve the manifest object
    function(callback) {
      var manifestPath = path.join(extractedBundlePath, manifestConstants.MANIFEST_FILENAME);
      manifest.getManifestObject(manifestPath, true, function(err, _manifestObj) {
        manifestObj = _manifestObj;
        callback(err);
        return;
      });
    },

    // Create a runit service
    function(callback) {
      deployServices.createService(serviceName, instanceVersionPath, manifestObj, callback);
    },

    // Symlink instace bundle version to "current"
    function(callback) {
      instance.activateVersion(bundleVersion, callback);
    },

    // Enable and start the runit service (if specified)
    function(callback) {
      if (!enableService) {
        callback();
        return;
      }

      deployServices.enableAndStartService(serviceName, callback);
    }
  ],

  function(err) {
    if (err && instance) {
      // If instance has been created but an error has been encountered, clean up
      // and remove the instance.
      instance.destroy(function() {
        callback(err);
        return;
      });
    }
    else {
      callback(err);
    }
  });
}

/**
 * Upgrade an instance to the specified bundle version.
 *
 * @param {String} instanceName   A name of the instance to upgrade.
 * @param {String} bundleVersion  The bundle version to which to upgrade.
 * @param {Function} callback     A callback fired with (err).
 */
function upgradeInstance(instanceName, bundleVersion, callback) {
  var instance;

  async.waterfall([
    // Verify that the instance exists
    function(callback) {
      getInstance(instanceName, callback);
    },

    function(_instance, callback) {
      instance = _instance;
      instance.getBundleName(callback);
    },

    // Verify that the bundle for the specified version exists
    function(bundleName, callback) {
      var bundleNameFull = misc.getFullBundleName(bundleName, bundleVersion);
      var extractedBundleRoot = path.join(config.get()['extracted_dir'], bundleName);
      var extractedBundlePath = path.join(extractedBundleRoot, bundleNameFull);

      path.exists(extractedBundlePath, function(exists) {
        var err = null;

        if (!exists) {
          err = new Errorf('Bundle %s version %s doesn\'t exist', bundleName, bundleVersion);
        }

        callback(err);
      });
    },

    function(callback) {
      instance.getBundleVersion(callback);
    },

    // Verify that user is not upgrading to the current version
    function(currentInstanceBundleVersion, callback) {
      var err = null;
      if (currentInstanceBundleVersion === bundleVersion) {
        err = new Errorf('Version %s is currently active version', bundleVersion);
      }

      callback(err);
    },

    function(callback) {
      instance.upgrade(bundleVersion, callback);
    }
  ],

  function(err) {
    callback(err);
  });
}

exports.Instance = Instance;
exports.getInstance = getInstance;
exports.getInstanceList = getInstanceList;
exports.createInstance = createInstance;
exports.upgradeInstance = upgradeInstance;
