
var Q = require("q"),
    PATH = require("path"),
    FS = require("fs"),
    UTIL = require("n-util");

const LOADER_PATH = require.resolve("sourcemint-loader-js/loader.js");


var Bundle = exports.Bundle = function(path)
{
    this.path = path;
    this.header = ["", {}];
    this.descriptors = {};
    this.modules = {};
    this.report = {};
    this.bundleLoader = [false, {}];
}

Bundle.prototype.reset = function()
{
    var self = this;
    return Q.call(function()
    {
        self.header = [];
        self.descriptors = {};
        self.modules = {};
        self.report = {};
    });
}

Bundle.prototype.open = function()
{
console.log("OPEN", this.path);
    
    var self = this,
        deferred = Q.defer();
    PATH.exists(self.path, function(exists)
    {
       if (exists) {
           // TODO: Write read/write lock so bundle can only be opened once for writing.
           Q.ncall(FS.readFile, FS, self.path, "utf8").then(function(code)
           {
               self.parseCode(code).then(function()
               {
console.log("OPENED", self.path);
                   
                   deferred.resolve();
               }, function(err)
               {
                   console.log("WARNING: Error '" + err + "' parsing bundle: " + self.path, err.stack);

                   // Reset everything so we can generate a clean bundle.
                   self.reset().then(deferred.resolve);
               });
           }).fail(deferred.reject);
       } else {
           self.save().then(function() {
               return self.open();
           }).then(deferred.resolve, deferred.reject);
       }
    });
    return deferred.promise;
}

Bundle.prototype.save = function()
{
    var self = this,
        deferred = Q.defer();
console.log("WRITE", this.path);
    FS.open(self.path, "w+", 0755, function(err, fd)
    {
        if (err) { deferred.reject(err); return; }

        Q.call(function()
        {
            return generateCode(fd);

        }).fail(deferred.reject).fin(function()
        {
            FS.close(fd, function(err) {
                if (err) { deferred.reject(err); return; }
                deferred.resolve();
            });
        });
    });
    
    function generateCode(fd)
    {
//        return write('//\n').then(function()
//        {
            return ((self.bundleLoader[0] === true)?writeLoader:writePayload)().then(function()
            {
                return writeFooter();
            });
//        });

        function write(str, position)
        {
            var deferred = Q.defer(),
                buffer = new Buffer(str, "utf8");
            if (typeof position === "undefined") position = null;
            FS.write(fd, buffer, 0, buffer.length, position, function(err, written, buffer)
            {
                if (err) { deferred.reject(err); return; }
                deferred.resolve(written);
            });
            return deferred.promise;
        }
        
        function writeLoader()
        {
            return write([
                '// @sourcemint-bundle-loader: ' + JSON.stringify(self.bundleLoader[1]),
                'var require, sourcemint;',
                '(function() {',
                '    var rootBundleLoader = function(uri, loadedCallback) {'
            ].join('\n') + '\n').then(function()
            {
                return writePayload().then(function()
                {
                    return write([
                        '// @sourcemint-bundle-ignore: ',
                        '        if (typeof loadedCallback === "function") loadedCallback();',
                        '    }',
                        '    function initLoader(exports) {'
                    ].join('\n') + '\n').then(function()
                    {
                        return Q.ncall(FS.readFile, FS, LOADER_PATH, "utf8").then(function(code)
                        {
                            return write(code).then(function()
                            {
                                return write([
                                    '    };',
                                    '    if (typeof sourcemint === "undefined") {',
                                    '        var exports = {};',
                                    '        initLoader(exports);',
                                    '        sourcemint = exports.require;',
                                    '        if (!require) require = sourcemint;',
                                    '        sourcemint.sandbox("' + ((self.bundleLoader[1].bundleUrlPrefix)?"{host}"+self.bundleLoader[1].bundleUrlPrefix:"") + PATH.basename(self.path) + '", function(sandbox) {',
                                    '            sandbox.main();',
                                    '        }, {',
                                    '            rootBundleLoader: rootBundleLoader',
                                    '        });',
                                    '    } else {',
                                    '        rootBundleLoader();',
                                    '    }',
                                    '})();'                  
                                ].join('\n') + '\n');
                            });
                        });
                    });
                });
            });
        }

        function writePayload()
        {
            return write('// @sourcemint-bundle-ignore: \nrequire.bundle("", function(require)\n{\n').then(function() {
                return write(generateHeader() + '\n').then(function() {
                    return write(generateModules() + '\n').then(function() {
                        return write(generateDescriptors() + '\n').then(function() {
                            return write('// @sourcemint-bundle-ignore: \n});\n');
                        });
                    });
                });
            });
        }

        function writeFooter()
        {
            var deferred = Q.defer();
            
            FS.fstat(fd, function(err, stats) {

                if (err) { deferred.reject(); return; }

                write('// @sourcemint-bundle-report: ' + JSON.stringify(self.report) + '\n').then(deferred.resolve, deferred.reject);

/*                
                write('// @sourcemint-bundle-report: ' + JSON.stringify(self.report) + '\n').then(function(written) {

                    write('// @sourcemint-bundle-partition-map: ' + JSON.stringify({
                        report: [stats.size, stats.size + written]
                    }), 0).then(deferred.resolve, deferred.reject);
                });
*/
            });
            
            return deferred.promise;
        }
        
        function generateHeader()
        {
            return [
                '// @sourcemint-bundle-header: ' + JSON.stringify(self.header[1]),
                self.header[0]
            ].join("\n");
        }
        
        function generateModules()
        {
            var code = [];
            UTIL.forEach(self.modules, function(moduleInfo)
            {
                code.push('// @sourcemint-bundle-module: ' + JSON.stringify(moduleInfo[1][1]));
                code.push('require.memoize("' + moduleInfo[0] + '", ');
                code.push(moduleInfo[1][0]);
                code.push(');');
            });
            return code.join("\n");
        }

        function generateDescriptors()
        {
            var code = [];
            UTIL.forEach(self.descriptors, function(descriptorInfo)
            {
                code.push('// @sourcemint-bundle-descriptor: ' + JSON.stringify(descriptorInfo[1][1]));
                code.push('require.memoize("' + descriptorInfo[0] + '", ');
                code.push(descriptorInfo[1][0]);
                code.push(');');
            });
            return code.join("\n");
        }
    }

    return deferred.promise;
}

Bundle.prototype.setBundleLoader = function(flag, info)
{
    this.bundleLoader = [flag, info || {}];
}

Bundle.prototype.setBundleHeader = function(code, info)
{
    this.header = [code, info || {}];
}

Bundle.prototype.setDescriptor = function(id, code, info)
{
    id = id || info.id;
    info.id = id;
    this.descriptors[id] = [code, info];
}

Bundle.prototype.setModule = function(id, code, info)
{
    id = id || info.id;
    info.id = id;
    this.modules[id] = [code, info];
}

Bundle.prototype.setReport = function(obj)
{
    this.report = obj;
}

Bundle.prototype.parseCode = function(code)
{
    var self = this,
        deferred = Q.defer();

    try
    {
        var codeParts = code.split(/((?:^|\n)\s*\/\/\s*@(sourcemint-bundle-[^:]*)\s*:\s*(.*?)\s*\n)/),
            i = 0;
    
        for (i = 0 ; i < (codeParts.length-1) ; i += 4)
        {
            if (codeParts[i+2] === "sourcemint-bundle-ignore") {
                // Ignore.
            } else
            if (codeParts[i+2] === "sourcemint-bundle-header") {
                self.setBundleHeader(codeParts[i+4], JSON.parse(codeParts[i+3]));
            } else
            if (codeParts[i+2] === "sourcemint-bundle-loader") {
                self.setBundleLoader(true, JSON.parse(codeParts[i+3]));
            } else
            if (codeParts[i+2] === "sourcemint-bundle-module") {
                self.setModule(null, codeParts[i+4].match(/^.*\n([\s\S]+)\n.*$/)[1], JSON.parse(codeParts[i+3]));
            } else
            if (codeParts[i+2] === "sourcemint-bundle-descriptor") {
                self.setDescriptor(null, codeParts[i+4].match(/^.*\n([\s\S]+)\n.*$/)[1], JSON.parse(codeParts[i+3]));
            } else
            if (codeParts[i+2] === "sourcemint-bundle-report") {
                self.setReport(JSON.parse(codeParts[i+3]));
            } else {
                throw new Error("Found unknown section type '" + codeParts[i+2] + "'!");
            }
        }

        deferred.resolve();
    }
    catch(e)
    {
        deferred.reject(e);
    }

    return deferred.promise;
}
