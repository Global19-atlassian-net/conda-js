var __makeProgressPromise = function(promise) {
    var callbacks = [];

    promise.progress = function(f) {
        callbacks.push(f);
        return this;
    };

    promise.onProgress = function(data) {
        callbacks.forEach(function(f) { f(data); });
    };

    return promise;
};

// Set up module to run in browser and in Node.js
// Based loosely on https://github.com/umdjs/umd/blob/master/nodeAdapter.js
if ((typeof module === 'object' && typeof define !== 'function') || (window && window.nodeRequire)) {
    // We are in Node.js or atom

    if (typeof window !== "undefined" && window.nodeRequire) {
        var require = window.nodeRequire;
    }

    var ChildProcess = require('child_process');
    var Promise = require('promise');

    // converts a name like useIndexCache to --use-index-cache
    var __convert = function(f) {
        return "--" + f.replace(/([A-Z])/g, function(a, b) { return "-" + b.toLocaleLowerCase(); });
    };

    var __parse = function(command, flags, positional) {
        if (typeof flags === "undefined") { flags = {}; }
        if (typeof positional === "undefined") { positional = []; }

        var cmdList = [command];

        for (var key in flags) {
            if (flags.hasOwnProperty(key)) {
                var value = flags[key];
                if (value !== false && value !== null) {
                    cmdList.push(__convert(key));

                    if (Array.isArray(value)) {
                        cmdList = cmdList.concat(value);
                    }
                    else if (value !== true) {
                        cmdList.push(value);
                    }
                }
            }
        }

        cmdList = cmdList.concat(positional);
        cmdList.push('--json');

        return cmdList;
    }

    var __spawn = function(cmdList) {
        var conda = ChildProcess.spawn('conda', cmdList, {});
        conda.stdout.setEncoding('utf8');
        return conda;
    };

    var api = function(command, flags, positional) {
        var cmdList = __parse(command, flags, positional);

        if (flags && typeof flags.quiet !== "undefined" && flags.quiet === false) {
            // Handle progress bars
            return progressApi(command, flags, positional);
        }

        var promise = new Promise(function(fulfill, reject) {
            try {
                var conda = __spawn(cmdList);
            }
            catch (ex) {
                reject({
                    'exception': ex
                });
                return;
            }

            var buffer = [];
            conda.stdout.on('data', function(data) {
                buffer.push(data);
            });

            conda.on('close', function() {
                try {
                    fulfill(JSON.parse(buffer.join('')));
                }
                catch (ex) {
                    reject({
                        'exception': ex,
                        'result': buffer.join('')
                    });
                }
            });
        });
        return promise;
    };

    // Returns Promise like api(), but this object has additional callbacks
    // for progress bars. Retrieves data via ChildProcess.
    var progressApi = function(command, flags, positional) {
        var cmdList = __parse(command, flags, positional);
        var promise = new Promise(function(fulfill, reject) {
            try {
                var conda = __spawn(cmdList);
            }
            catch (ex) {
                reject({
                    'exception': ex
                });
                return;
            }

            var progressing = true;
            var buffer = [];
            conda.stdout.on('data', function(data) {
                var rest = data;
                if (rest.indexOf('\0') == -1) {
                    progressing = false;
                }
                else {
                    // Handles multiple progress bars (e.g. fetch then install)
                    progressing = true;
                }

                if (!progressing) {
                    buffer.push(data);
                    return;
                }
                while (rest.indexOf('\0') > -1 && progressing) {
                    var dataEnd = rest.indexOf('\0');
                    var first = rest.slice(0, dataEnd);
                    rest = rest.slice(dataEnd + 1);
                    buffer.push(first);
                    var json = JSON.parse(buffer.join(''));
                    buffer = [];
                    promise.onProgress(json);

                    if (json.finished === true) {
                        progressing = false;
                    }
                }
            });

            conda.on('close', function() {
                try {
                    fulfill(JSON.parse(buffer.join('')));
                }
                catch(ex) {
                    reject({
                        'exception': ex,
                        'result': buffer.join('')
                    });
                }
            });
        });
        return __makeProgressPromise(promise);
    };

    module.exports = factory(api);
    module.exports.api = api;
    module.exports.progressApi = progressApi;
}
else {
    // We are in the browser
    var __parse = function(flags, positional) {
        if (typeof flags === "undefined") {
            flags = {};
        }
        if (typeof positional === "undefined") {
            positional = [];
        }

        var data = flags;
        data.positional = positional;

        return data;
    }

    var rpcApi = function(command, flags, positional) {
        // URL structure: /api/command
        // Flags are GET query string or POST body
        // Positional is in query string or POST body

        // Translation of JS flag camelCase to command line flag
        // dashed-version occurs server-side

        var data = __parse(flags, positional);

        if (flags && typeof flags.quiet !== "undefined" && flags.quiet === false) {
            // Handle progress bars
            return progressApi(command, flags, positional);
        }

        var method = 'post';
        if (['info', 'list', 'search'].indexOf(command) !== -1 ||
            command === 'config' && flags.get) {
            method = 'get';
        }

        var contentType = '';
        if (method === 'post') {
            contentType = 'application/json';
            data = JSON.stringify(data);
        }

        return Promise.resolve($.ajax({
            contentType: contentType,
            data: data,
            dataType: 'json',
            type: method,
            url: window.conda.API_ROOT + "/" + command
        }));
    };

    var restApi = function(command, flags, positional) {
        // URL structure is same as RPC API, except commands involving an
        // environment are structured more RESTfully - additionally, we use
        // GET/POST/PUT/DELETE based on the subcommand.
        // Commands involving --name and --prefix are translated to
        // /api/env/name/<name>/subcommand<? other Argos>
        var data = __parse(flags, positional);
        var url = '';

        if (typeof data.name !== "undefined") {
            url += '/env/name/' + encodeURIComponent(data.name);
        }
        else if (typeof data.prefix !== "undefined") {
            url += '/env/prefix/' + encodeURIComponent(data.prefix);
        }

        delete data['name'];
        delete data['prefix'];

        if (['install', 'update', 'remove'].indexOf(command) > -1) {
            if (data.positional.length !== 1) {
                throw new window.conda.CondaError('conda: REST API supports only manipulating one package at a time');
            }
            url += '/' + data.positional[0];
        }
        else if (command === 'create') {
        }
        else {
            url += '/' + command;
        }

        var method = {
            'install': 'post',
            'create': 'post',
            'update': 'put',
            'remove': 'delete'
        }[command];
        if (typeof method === "undefined") {
            method = 'get';
        }

        if (command === 'config') {
            if (typeof data.add !== "undefined") {
                method = 'put';
                url += '/' + data.add[0] + '/' + data.add[1];
            }
            else if (typeof data.set !== "undefined") {
                method = 'put';
                data.value = data.set[1];
            }
            else if (typeof data.remove !== "undefined") {
                method = 'delete';
                url += '/' + data.remove[0] + '/' + data.remove[1];
            }
            else if (typeof data.removeKey !== "undefined") {
                method = 'delete';
            }
            else if (typeof data.get !== "undefined") {
                url += '/' + data.get;
            }
            delete data['get'];
            delete data['add'];
            delete data['set'];
            delete data['remove'];
            delete data['removeKey'];
        }

        if (typeof data.positional !== "undefined") {
            data.q = data.positional;
            delete data.positional;
        }

        return Promise.resolve($.ajax({
            contentType: 'application/json',
            data: data,
            dataType: 'json',
            type: method,
            url: window.conda.API_ROOT + url
        }));
    };

    var api = function(command, flags, positional) {
        if (window.conda.API_METHOD === "RPC") {
            return rpcApi(command, flags, positional);
        }
        else if (window.conda.API_METHOD === "REST") {
            return restApi(command, flags, positional);
        }
        else {
            throw new window.conda.CondaError("conda: Unrecognized API_METHOD " + window.conda.API_METHOD);
        }
    };

    // Returns Promise like api(), but this object has additional callbacks
    // for progress bars. Retrieves data via websocket.
    var progressApi = function(command, flags, positional) {
        var promise = new Promise(function(fulfill, reject) {
            var data = __parse(flags, positional);
            positional = data.positional;
            delete data.positional;

            var socket = new SockJS('http://' + window.location.host + window.conda.API_ROOT + '_ws/');
            socket.onopen = function() {
                socket.send(JSON.stringify({
                    subcommand: command,
                    flags: data,
                    positional: positional
                }));
            };
            socket.onmessage = function(e) {
                var data = JSON.parse(e.data);
                if (typeof data.progress !== "undefined") {
                    promise.onProgress(data.progress);
                }
                else if (typeof data.finished !== "undefined") {
                    fulfill(data.finished);
                }
            };
        });

        return __makeProgressPromise(promise);
    };

    window.conda = factory(api);
}

function factory(api) {
    "use strict";

    var defaultOptions = function(options, defaults) {
        if (typeof options === "undefined" || options === null) {
            return defaults;
        }
        for (var key in defaults) {
            if (defaults.hasOwnProperty(key)) {
                if (typeof options[key] === "undefined") {
                    options[key] = defaults[key];
                }
            }
        }

        return options;
    };

    var nameOrPrefixOptions = function(name, options, defaults) {
        defaults.name = null;
        defaults.prefix = null;

        options = defaultOptions(options, defaults);
        if (!(options.name || options.prefix)) {
            throw new CondaError(name + ": either name or prefix required");
        }
        if (options.name && options.prefix) {
            throw new CondaError(name + ": exactly one of name or prefix allowed");
        }

        return options;
    };

    var CondaError = (function() {
        function CondaError(message) {
            this.message = message;
        }

        CondaError.prototype.__proto__ = new Error;

        CondaError.prototype.toString = function() {
            return "CondaError: " + this.message;
        };

        return CondaError;
    })();

    var Env = (function() {
        function Env(name, prefix) {
            this.name = name;
            this.prefix = prefix;

            this.is_default = false;
            this.is_root = false;

            this.installed = {};
            this.history = [];
        }

        Env.prototype.linked = function(options) {
            options = defaultOptions(options, { simple: false });

            return api('list', { prefix: this.prefix }).then(function(fns) {
                if (options.simple) {
                    return fns;
                }

                var promises = [];
                for (var i = 0; i < fns.length; i++) {
                    promises.push(Package.load(fns[i]));
                }
                return Promise.all(promises).then(function(pkgs) {
                    this.installed = {};
                    pkgs.forEach(function(pkg) {
                        this.installed[pkg.name] = pkg;
                    }.bind(this));
                    return pkgs;
                }.bind(this));
            }.bind(this));
        };

        Env.prototype.revisions = function() {
            return api('list', { prefix: this.prefix, revisions: true })
                .then(function(revisions) {
                    this.history = revisions;
                    return revisions;
                }.bind(this));
        };

        Env.prototype.install = function(options) {
            options = defaultOptions(options, {
                progress: false,
                packages: []
            });

            if (options.packages.length === 0) {
                throw new CondaError("Env.install: must specify at least one package");
            }

            var packages = options.packages;
            delete options.packages;

            options.quiet = !options.progress;
            delete options.progress;
            options.prefix = this.prefix;

            return api('install', options, packages);
        };

        Env.prototype.update = function(options) {
            options = defaultOptions(options, {
                packages: [],
                dryRun: false,
                unknown: false,
                noDeps: false,
                useIndexCache: false,
                useLocal: false,
                noPin: false,
                all: false,
                progress: false
            });

            if (options.packages.length === 0 && !options.all) {
                throw new CondaError("Env.update: must specify packages to update or all");
            }

            var packages = options.packages;
            delete options.packages;

            options.quiet = !options.progress;
            delete options.progress;
            options.prefix = this.prefix;

            return api('update', options, packages);
        };

        Env.prototype.remove = function(options) {
            options = defaultOptions(options, {
                progress: false,
                packages: []
            });

            if (options.packages.length === 0) {
                throw new CondaError("Env.remove: must specify at least one package");
            }

            var packages = options.packages;
            delete options.packages;

            options.quiet = !options.progress;
            delete options.progress;
            options.prefix = this.prefix;

            return api('remove', options, packages);
        };

        Env.prototype.clone = function(options) {
            var options = nameOrPrefixOptions("Env.clone", options, {
                progress: false
            });

            options.clone = this.prefix;
            options.quiet = !options.progress;
            delete options.progress;

            return api('create', options).then(function(data) {
                if (typeof data.success !== "undefined" && data.success) {
                    data.env = new Env(options.name, data.actions.PREFIX);
                    return data;
                }
                else {
                    this.reject(data);
                }
            });
        };

        Env.prototype.run = function(options) {
            var options = defaultOptions(options, {
                name: null,
                pkg: null
            });

            if (!(options.name || options.pkg)) {
                throw new CondaError("Env.run: either name or pkg needed");
            }
            if (options.name && options.pkg) {
                throw new CondaError("Env.run: exactly one of name or pkg allowed");
            }

            var pkg = options.name;
            if (options.pkg) {
                pkg = options.pkg;
            }

            return api('run', { prefix: this.prefix }, [pkg]);
        };

        Env.prototype.removeEnv = function(options) {
            options = defaultOptions(options, {
                progress: false
            });

            return api('remove', {
                all: true,
                prefix: this.prefix,
                quiet: !options.progress
            });
        };

        Env.create = function(options) {
            var options = nameOrPrefixOptions("Env.create", options, {
                progress: false,
                packages: []
            });

            if (options.packages.length === 0) {
                throw new CondaError("Env.create: at least one package required");
            }

            var packages = options.packages;
            delete options.packages;
            options.quiet = !options.progress;
            delete options.progress;

            var progress = api('create', options, packages);
            var promise = progress.then(function(data) {
                if (typeof data.success !== "undefined" && data.success) {
                    data.env = new Env(options.name, data.actions.PREFIX);
                }
                return data;
            });
            // TODO formalize/automate this - preserves progress API
            if (typeof progress.progress !== "undefined") {
                promise.progress = progress.progress.bind(progress);
            }
            return promise;
        };

        Env.getEnvs = function() {
            return info().then(function(info) {
                var envs = [new Env('root', info.default_prefix)];

                var prefixes = info.envs;
                for (var i = 0; i < prefixes.length; i++) {
                    var prefix = prefixes[i];
                    var name = prefix.split('/'); // TODO Windows?
                    name = name[name.length - 1];
                    envs.push(new Env(name, prefix));
                }

                envs.forEach(function(env) {
                    env.is_default = env.prefix == info.default_prefix;
                    env.is_root = env.prefix == info.root_prefix;
                });
                return envs;
            });
        };

        Env.getRoot = function() {
            return info().then(function(info) {
                var root = new Env('root', info.default_prefix);
                root.isDefault = true;
                root.isRoot = true;

                return root;
            });
        };

        /**
           Sync method for Backbone collections.
         */
        Env.backboneSync = function(method, model, options) {
            switch (method) {
            case "read":
                Env.getEnvs().then(function(envs) {
                    var promises = [];
                    envs.forEach(function(env) {
                        if (typeof options.loadLinked === "undefined" ||
                            options.loadLinked) {
                            promises.push(env.linked());
                        }
                        if (typeof options.loadRevisions === "undefined" ||
                            options.loadRevisions) {
                            promises.push(env.revisions());
                        }
                        env.id = env.prefix ? env.prefix : env.name;
                    });

                    Promise.all(promises).then(function() {
                        options.success(envs);
                    });
                });
                break;

            case "delete":
                return model.attributes.removeEnv().then(function(result) {
                    options.success(result);
                });
                break;

            default:
                console.log("Env.backboneSync: cannot handle method " + method);
            }
        };

        return Env;
    })();

    var Package = (function() {
        var _cache = {};
        var _search_cache = {};
        var _search_cache_promise = null;

        function Package(fn, info) {
            _cache[fn] = this;
            this.fn = fn;
            this.name = info.name;
            this.build = info.build;
            this.dist = this.fn;
            this.version = info.version;
            this.info = info;
        }

        Package.prototype.reload = function() {
            return Package.load(this.fn).then(function(pkg) {
                this.info = pkg.info;
            }.bind(this));
        };

        Package.splitFn = function(fn) {
            var parts = fn.split('-');
            return {
                name: parts.slice(0, -2).join('-'),
                build: parts[parts.length - 1],
                version: parts[parts.length - 2]
            };
        };

        Package.load = function(fn, reload) {
            // This can get quite expensive. To deal with that:
            // 1. Cache Package objects.
            // 2. Load data from `conda search`'s index.
            // 3. Cache that index.
            // 4. Fall back on `conda info` only if package is not in index
            // (when the package was built/installed locally, for instance)
            if (_search_cache_promise === null) {
                _search_cache_promise = search().then(function(result) {
                    _search_cache = result;
                });
            }
            if (typeof reload === "undefined") {
                reload = false;
            }

            if (!_cache.hasOwnProperty(fn) || reload) {
                return _search_cache_promise.then(function(search) {
                    var spec = Package.splitFn(fn);
                    var packages = _search_cache[spec.name];
                    if (typeof packages === "undefined") {
                        return api('info', {}, fn + '.tar.bz2').then(function(info) {
                            info = info[fn + '.tar.bz2'];
                            var pkg = new Package(fn, info);
                            return pkg;
                        });
                    }

                    var pkgInfo;
                    for (var i = 0; i < packages.length; i++) {
                        var info = packages[i];
                        if (info.build === spec.build && info.version === spec.version) {
                            pkgInfo = info;
                            break;
                        }
                    }

                    var pkg = new Package(fn, info);
                    _cache[fn] = pkg;
                    return pkg;
                });
            }
            else {
                return Promise.resolve(_cache[fn]);
            }
        };

        return Package;
    })();

    var Config = (function() {
        var __warn_result = function(result) {
            if (result.warnings && result.warnings.length) {
                console.log("Warnings for conda config:");
                console.log(result.warnings);
            }
            return result;
        };
        var __merge = function(dest, src) {
            for (var key in src) {
                if (src.hasOwnProperty(key)) {
                    dest[key] = src[key];
                }
            }

            return dest;
        };
        var ALLOWED_KEYS = ['channels', 'disallow', 'create_default_packages',
            'track_features', 'envs_dirs', 'always_yes', 'allow_softlinks', 'changeps1',
            'use_pip', 'binstar_upload', 'binstar_personal', 'show_channel_urls',
            'allow_other_channels', 'ssl_verify'];

        var __check_keys = function(f) {
            return function() {
                var key = arguments[0];
                if (ALLOWED_KEYS.indexOf(key) === -1) {
                    throw new CondaError(
                        "Config.get: key " + key + " not allowed. Key must be one of "
                            + ALLOWED_KEYS.join(', '));
                }
                return f.apply(f, Array.prototype.slice.call(arguments));
            };
        };

        function Config(options) {
            options = defaultOptions(options, {
                system: false,
                file: null
            });
            this.system = options.system;
            this.file = options.file;
            this.options = {};

            if (options.system && options.file !== null) {
                throw new CondaError("Config: at most one of system, file allowed");
            }

            if (options.system) {
                this.options.system = true;
            }
            else if (options.file !== null) {
                this.options.file = options.file;
            }
        }

        Config.prototype.rcPath = function() {
            var call = api('config', __merge({ get: true }, this.options));
            return call.then(function(result) {
                return result.rc_path;
            });
        };

        Config.prototype.get = __check_keys(function(key) {
            var call = api('config', __merge({ get: key }, this.options));
            return call.then(__warn_result).then(function(result) {
                if (typeof result.get[key] !== "undefined") {
                    return {
                        value: result.get[key],
                        set: true
                    };
                }
                else {
                    return {
                        value: undefined,
                        set: false
                    };
                }
            });
        });

        Config.prototype.getAll = function() {
            var call = api('config', __merge({ get: true }, this.options));
            return call.then(function(result) {
                return result.get;
            });
        };

        // TODO disallow non iterable keys
        Config.prototype.add = __check_keys(function(key, value) {
            var call = api('config', __merge({ add: [key, value], force: true }, this.options));
            return call.then(__warn_result);
        });

        Config.prototype.set = __check_keys(function(key, value) {
            var call = api('config', __merge({ set: [key, value], force: true }, this.options));
            return call.then(__warn_result);
        });

        Config.prototype.remove = __check_keys(function(key, value) {
            var call = api('config', __merge({ remove: [key, value], force: true }, this.options));
            return call.then(__warn_result);
        });

        Config.prototype.removeKey = __check_keys(function(key) {
            var call = api('config', __merge({ removeKey: key, force: true }, this.options));
            return call.then(__warn_result);
        });

        return Config;
    })();

    var info = function() {
        return api('info');
    };

    var search = function(options) {
        options = defaultOptions(options, {
            regex: null,
            spec: null
        });

        if (options.regex && options.spec) {
            throw new CondaError("conda.search: only one of regex and spec allowed");
        }

        var positional = [];

        if (options.regex !== null) {
            positional.push(options.regex);
        }
        if (options.spec !== null) {
            positional.push(options.spec);
            options.spec = true;
        }
        else {
            delete options.spec;
        }
        delete options.regex;

        return api('search', options, positional);
    };

    var run = function(command) {
        return api('run', {}, [command]);
    };

    var clean = function(options) {
        options = defaultOptions(options, {
            dryRun: false,
            indexCache: false,
            lock: false,
            tarballs: false,
            packages: false
        });

        if (!(options.indexCache || options.lock ||
              options.tarballs || options.packages)) {
            throw new CondaError("conda.clean: at least one of indexCache, " +
                                 "lock, tarballs, or packages required");
        }

        return api('clean', options);
    };

    return {
        clean: clean,
        info: info,
        run: run,
        search: search,
        CondaError: CondaError,
        Config: Config,
        Env: Env,
        Package: Package,
        API_ROOT: '/api',
        API_METHOD: 'RPC'
    };
}
