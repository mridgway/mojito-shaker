/*
 * Copyright (c) 2011-2012, Yahoo! Inc.  All rights reserved.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */
var path = require('path'),
    mojito,
    fs = require('fs'),
    gear = require('gear'),
    async = require('async'),
    mkdirp = require('mkdirp'),
    mime = require('mime'),
    ShakerCore = require('./core').ShakerCore,
    logger = require('./core').logger,
    utils = require('./utils');

/*
 * Gear.js builder for images.
 *
 * @param name {string} Name of image to build
 * @param file {string} Filename of image
 */
function Image(name, file) {
    this._name = name;
    this._file = file;
}

Image.prototype = {
    build: function (registry, options, callback) {
        var config = utils.simpleClone(options.config),
            queue = new gear.Queue({registry: registry})
                .read({name: this._file, encoding: 'bin'});

        config.name = this._name;
        config.encoding = 'bin';
        queue.task(options.task, config)
            .run(function(err, results) {
                if (err) {
                    logger.error('[SHAKER] - Failed to build file ' + config.name + ' (' + err + ')');
                    callback(err);
                    return;
                }
                var result = results[0];
                callback(null, result.url ? result.url : config.root + result.name);
            });
    }
};

/*
 * Gear.js builder for Javascript/CSS.
 *
 * @param name {string} Name of rollup to build
 * @param files {array} Filenames to rollup
 */
function Rollup(name, files) {
    this._name = name;
    this._files = files.map(function (file) {
        return {name: file, sync: true };
    });
}

Rollup.prototype = {
    build: function (registry, options, callback) {
        var config = utils.simpleClone(options.config),
            queue = new gear.Queue({registry: registry})
                .read(this._files)
                .concat();

        if (options.strip) {
            queue.replace(options.strip);
        }
        if (options.minify) {
            queue.task(mime.lookup(this._name) === 'application/javascript' ? 'jsminify' : 'cssminify');
        }

        config.name = this._name;
        queue.task(options.task, config)
            .run(function(err, results) {
                if (err) {
                    logger.error('[SHAKER] - Failed to build file ' + config.name + ' (' + err + ')');
                    callback(err);
                    return;
                }
                var result = results[0];
                callback(null, result.url ? result.url : config.root + result.name, result.skipped);
            });
    }
};

/*
 * Gear.js builder for templates.
 *
 * @param name {string} Name of template to build
 * @param files {array} Filenames to rollup
 */
function ClientRollup(name, base, files) {
    this._name = name;
    this._base = base;
    this._files = files.map(function (file) {
        return {name: file, sync: true };
    });
}

ClientRollup.prototype = {
    build: function (registry, options, callback) {
        var config = utils.simpleClone(options.config),
            queue = new gear.Queue({registry: registry})
                .read(this._files)
                .concat({
                    callback: function (blob) {
                        var filename = blob.name,
                            result = blob.result;
                        if (mime.lookup(filename) === 'text/html') {
                            if(options.bundleViews) {
                                var npm = filename.indexOf('node_modules') !== -1,
                                    parts = npm ? filename.match(/.*\/?node_modules\/(.*)\/views.*\/(.*)\.(.*)\.html/) :
                                                  filename.match(/.*\/?mojits\/(.*)\/views.*\/(.*)\.(.*)\.html/),
                                    mojit = parts[1],
                                    action = parts[2],
                                    renderer = parts[3],
                                    json = JSON.stringify(result);

                                result = 'YUI.add("views/' + mojit + '/' + action + '", function (Y, NAME) {\n';
                                result += '\tYUI.namespace("_mojito._cache.compiled.' + mojit + '.views");\n';
                                result += '\tYUI._mojito._cache.compiled.' + mojit + '.views.' + action + ' = ' + json + ';\n';
                                result += '});';

                            } else {
                                result = "";
                            }
                        }
                        
                        return result;
                    }
                });

        if (options.strip) {
            queue.replace(options.strip);
        }

        if (options.minify) {
            queue.jsminify();
        }

        config.name = this._name;
        queue.task(options.task, config)
            .run(function(err, results) {
                if (err) {
                    logger.error('[SHAKER] - Failed to build file ' + config.name + ' (' + err + ')');
                    callback(err);
                    return;
                }
                var result = results[0];
                callback(null, result.url ? result.url : config.root + result.name);
            });
    }
};

/**
 * Shaker compiler.
 *
 * Compiler takes metadata generated by the core and depending on the environment context
 * will run tasks against the assets. Tasks including concatenating, minifying, and deploying to
 * a variety of locations (local, cdn).
 *
 * Sample application.json:
 *   ...
 *   {
 *       "settings": ["environment:test"],
 *       "shaker": {
 *           "task": "local"
 *       }
 *   },
 *   ...
 *
 * Example:
 * new Shaker({store: store}).run(function (metadata) {
 *    console.log(metadata);
 * )});
 *
 * @param core {Object} A Shaker core object for a Mojito app.
 */
function Shaker (options) {
    this._core = new ShakerCore(options);

    var shaker = this._core.getShakerConfig(),
        cwd = process.cwd();

    this._task = Shaker.DEFAULT_TASK;
    if (shaker.task) { // Task to run when compiling assets
        this._task = shaker.task === 'local' ? 'write' : shaker.task;
    }
    this._compiled_dir = shaker.compiled_dir || Shaker.COMPILED_DIR;
    this._images = shaker.images !== undefined ? shaker.images : false; // Deploy images
    this._parallel = shaker.parallel !== undefined ? shaker.parallel : 20; // How many tasks the async queue runs
    this._delay = shaker.delay !== undefined ? shaker.delay : 0; // Add some network delay for slow connections
    this._lint = shaker.lint !== undefined ? shaker.lint : true; // lint or not
    this._minify = shaker.minify !== undefined ? shaker.minify : true; // Uglify or not
    this._strip = shaker.strip; // Replace or not regular expression
    this._config = shaker.config || {}; // Config object passed through to task
    this._config.root = this._core.getStaticRoot();

    this._registry = new gear.Registry({dirname: path.resolve(__dirname, '../', 'node_modules', 'gear-lib', 'lib')});

    if (path.existsSync(Shaker.TASKS_DIR)) {    // Load more tasks
        this._registry.load({dirname: Shaker.TASKS_DIR});
    }
    if (shaker.module) {
        this._registry.load({module: shaker.module});
    }
}

Shaker.DEFAULT_TASK = 'raw';
Shaker.TASKS_DIR = __dirname + '/tasks/'; // Tasks in this directory can be directly referenced in application.json
Shaker.ASSETS_DIR = 'assets/';
Shaker.COMPILED_DIR = Shaker.ASSETS_DIR + 'compiled/'; // Where we write the rollups
Shaker.IMAGES_DIR = Shaker.ASSETS_DIR + 'images/';

Shaker.prototype = {
    /*
     * Start compiling assets.
     *
     * @param callback {function} Callback when compiling is complete.
     */
    run: function (callback) {
        if(!this._core.isMojitApp()){
            console.log('[SHAKER ERROR] application.json not present. Terminating Shaker.');
            callback('ERROR');
            return;
        }
        logger.log('[SHAKER] - Analizying application assets to Shake... ');
        var metadata = this._core.run({ignore_dir: this._compiled_dir});

        if (this._lint) {
            this._lintFiles(this._runTask.bind(this, metadata, callback));
        } else {
            this._runTask(metadata, callback);
        }
    },

    _runTask: function(metadata, callback) {
        if (this._task === Shaker.DEFAULT_TASK) {
            this._rename(metadata);
            this._writeMeta(metadata);
            callback(null, metadata);
        }
        else {
            this._compileRollups(metadata, callback);
        }
    },

    /*
     * Rename assets from local filename to URL.
     *
     * @param metadata {Object} Core metadata to augment.
     */
    _rename: function (metadata) {
        logger.log('[SHAKER] - Processing assets for development env.');
        var mojit, action, dim, item, list, renamed;

        // Mojit assets
        for (mojit in metadata.mojits) {
            for (action in metadata.mojits[mojit]) {
                for (dim in metadata.mojits[mojit][action].shaken) {
                    for (item in metadata.mojits[mojit][action].shaken[dim]) {
                        list = metadata.mojits[mojit][action].shaken[dim];
                        list[item] = this._core.getURL(list[item]);
                    }
                }
                for(item in (list = metadata.mojits[mojit][action].client)){
                    list[item] = this._core.getURL(list[item]);
                }
            }
        }

        // App level assets
        for (action in metadata.app) {
            for (dim in metadata.app[action].shaken) {
                for (item in (list = metadata.app[action].shaken[dim])) {
                    list[item] = this._core.getURL(list[item]);
                }
            }
            for(item in (list = list = metadata.app[action].client)){
                    list[item] = this._core.getURL(list[item]);
            }
        }
        //Core
        for (item in (list = metadata.core)) {
            list[item] = this._core.getURL(list[item]);
        }
    },

    _lintFiles: function (callback) {
        var files = [],
            file,
            filtered = {},
            queue;

        for (file in this._core.getFiles()) {
            files.push(file);
        }
        
        filtered = this._filterFiles(files, true);

        if (filtered.css.length > 0) {
            new gear.Queue({registry: this._registry})
                .read(filtered.css)
                .csslint({callback: function(blob) {
                    var name = (blob.name ? blob.name : 'files...');
                    logger.log('[SHAKER] - Linting ' + name);
                    if (blob.csslint.length) {
                        logger.error(name + ' - ' + blob.csslint.length + ' CSSLint errors:');
                        blob.csslint.forEach(function(error) {
                            logger.error(error);
                        });
                        return '[SHAKER] - Aborting';
                    }
                }})
                .run(function(err, results) {
                    if (err) {
                        logger.error(err);
                    } else {
                        callback();
                    }
                });
        }
    },

    /*
     * The workhorse of compiler. Loads the queue and processes the results. We modify the original metadata
     * lists for simplicity.
     *
     * @param metadata {Object} Core metadata to augment.
     * @param callback {function} Callback when rollups are compiled.
     */
    _compileRollups: function (metadata, callback) {
        logger.log('[SHAKER] - Compiling rollups...');
        var queue,
            self = this;

        queue = async.queue(function (item, taskCallback) {
            setTimeout(function () {
                var options = {
                    task: self._task,
                    minify: self._minify,
                    strip: self._strip,
                    config: self._config
                };
                item.object.build(self._registry, options, function (err, url, skipped) {
                    if (err) {
                        // No way to kill queue so throw exception (async bug)
                        logger.error('[SHAKER] Stack trace:');
                        throw err;
                    }

                    if (!skipped) {
                        logger.log('[SHAKER] - Pushed file ' + url);
                    }
                    
                    item.files.push(url);
                    taskCallback();
                });
            }, self._delay);
        }, this._parallel);

        queue.drain = function () {
            self._writeMeta(metadata);
            callback(null, metadata);
        };

        this._queueRollups(queue, metadata);
    },

    /*
     * Add all assets referenced by metadata to an async queue.
     *
     * @param queue {Object} Queue to append tasks to.
     * @param metadata {Object} Core metadata to look through.
     */
    _queueRollups: function (queue, metadata) {
        var mojit, action, dim, files, name, client, filtered;
        // We need to add images so they can be referenced by relative URLs in the deployed CSS.
        if (this._images) {
            metadata.images.forEach(function (image) {
                queue.push({
                    object: new Image(Shaker.IMAGES_DIR + path.basename(image), image),
                    files: metadata.images
                });
            });
            metadata.images.length = 0;
        }

        // Mojito core assets
        queue.push({
            object: new Rollup(this._compiled_dir + 'core_{checksum}.js', metadata.core.slice() /* Clone */),
            files: metadata.core
        });
        metadata.core.length = 0;

        // Mojit assets
        for (mojit in metadata.mojits) {
            for (action in metadata.mojits[mojit]) {
                // Mojit client assets
                client = metadata.mojits[mojit][action].client;
                if (client.length) {
                    queue.push({
                        object: new ClientRollup(this._compiled_dir + 'client_' + mojit + '_{checksum}.js', this._core.getAppRoot(), client.slice() /* Clone */),
                        files: client
                    });
                    client.length = 0;
                }

                for (dim in (files = metadata.mojits[mojit][action].shaken)) {
                    if (files[dim].length) {
                        name = mojit + '_' + action.replace('*', 'default') + '_{checksum}';
                        filtered = this._filterFiles(files[dim]);

                        if (filtered.js.length) {
                            queue.push({
                                object: new Rollup(this._compiled_dir + name + '.js', filtered.js),
                                files: files[dim]
                            });
                        }
                        if (filtered.css.length) {
                            queue.push({
                                object: new Rollup(this._compiled_dir + name + '.css', filtered.css),
                                files: files[dim]
                            });
                        }
                        files[dim].length = 0;
                    }
                }
            }
        }

        // App level assets
        for (action in metadata.app) {
            // App client assets
            client = metadata.app[action].client;
            if (client.length) {
                queue.push({
                    object: new ClientRollup(this._compiled_dir + 'appclient_' + action + '_{checksum}.js', this._core.getAppRoot(), client.slice() /* Clone */ ),
                    files: client
                });
                client.length = 0;
            }

            for (dim in (files = metadata.app[action].shaken)) {
                if (files[dim].length) {
                    name = 'app_' + action.replace('*', 'default') + '_{checksum}';
                    filtered = this._filterFiles(files[dim]);

                    if (filtered.js.length) {
                        queue.push({
                            object: new Rollup(this._compiled_dir + name + '.js', filtered.js),
                            files: files[dim]
                        });
                    }
                    if (filtered.css.length) {
                        queue.push({
                            object: new Rollup(this._compiled_dir + name + '.css', filtered.css),
                            files: files[dim]
                        });
                    }
                    files[dim].length = 0;
                }
            }
        }
    },

    /*
     * Separate JS and CSS files into separate arrays.
     *
     * @param files {array} List of JS/CSS filenames.
     */
    _filterFiles: function (files, syncWrap) {
        var js = [],
            css = [];

        files.forEach(function (file) {
            var type = mime.lookup(file);

            if (type === 'application/javascript') {
                js.push(syncWrap ? {name:file, sync:true} : file);
            } else if (type === 'text/css') {
                css.push(syncWrap ? {name:file, sync:true} : file);
            }
        });

        return {'js': js, 'css': css};
    },

    /*
     * Write the modified metadata.
     *
     * @param metadata {Object} Core metadata to write to file.
     */
    _writeMeta: function (metadata) {
        var self = this,
            content = "";

        content += 'YUI.add("shaker/metaMojits", function (Y, NAME) {\n';
        content += 'YUI.namespace("_mojito._cache.shaker");\n';
        content += 'YUI._mojito._cache.shaker.meta = \n';
        content += JSON.stringify(metadata, null, '\t');
        content += '});';

        logger.log('[SHAKER] - Writting addon metadata file');
        mkdirp.sync(self._core.getAppRoot() + '/autoload/compiled', 0777 & (~process.umask()));
        fs.writeFileSync(self._core.getAppRoot() + '/autoload/compiled/shaker-meta.common.js', content);
    }
};

exports.Shaker = Shaker;
