
var PATH = require("path"),
	FS = require("fs"),
	Q = require("q"),
	PACKAGE = require("./package"),
	CRYPTO = require("crypto"),
	UTIL = require("n-util"),
	GLOB = require("glob"),
	WRENCH = require("wrench");


exports.bundle = function(packagePath, distributionPath, options)
{
	if (!PATH.existsSync(distributionPath))
	{
		throw new Error("Distribution path '" + distributionPath + "' does not exist!");
	}
	// TODO: Make distribution path configurable via `options`.
	distributionPath = distributionPath + "/" + PATH.basename(packagePath);

	return ((new Bundler(packagePath, distributionPath, options)).generateBundles());
}


var Bundler = function(packagePath, distributionPath, options)
{
	this.packagePath = FS.realpathSync(packagePath);
	if (!FS.statSync(this.packagePath).isDirectory())
	{
		throw new Error("Package path '" + packagePath + "' is not a directory!");
	}
	this.distributionPath = distributionPath;

	this.options = options || {};
	
	if (!this.options.packageIdHashSeed)
	{
		this.options.packageIdHashSeed = new Date().getTime() + Math.random();
	}

	// Give back a promise for the package until it has been provisioned locally.
	var deferred = Q.defer();
	this.getInitializedPackageForPath(this.packagePath).then(function(pkg) {
		deferred.resolve(pkg);
	});
	this.programPackage = function() {
		return deferred.promise;
	};
}


Bundler.prototype.generateReport = function()
{
	var self = this;
	return Q.when(self.programPackage(), function(pkg)
	{
		var masterReport = {
				mainPackage: self.packagePath,
				packages: {}
			};

		return pkg.buildReport(masterReport);
	});
}


Bundler.prototype.getInitializedPackageForPath = function(path, options)
{
	options = options || {};
	var opts = UTIL.copy(this.options);
	opts.bundler = this;
	opts.descriptor = options.descriptor || {};
	return (new PACKAGE.Package(path)).init(opts);
}


Bundler.prototype.generateBundles = function()
{
	var self = this,
		masterReport = {
			sourceReport: {},
			mappedReport: {},
			bundleReport: {
				mainBundle: false,
				packages: {},
				modules: {}
			}
		},	
		packagePathIdMap = {},
		packageDescriptors = [],
		dynamicLoadBundles = [];

	function packageIdForPath(path)
	{
		if (packagePathIdMap[path])
		{
			return packagePathIdMap[path];
		}
		
		var shasum = CRYPTO.createHash("sha1");
		shasum.update(self.options.packageIdHashSeed + ":" + path);
		packagePathIdMap[path] = shasum.digest("hex");

		masterReport.bundleReport.packages[packagePathIdMap[path]] = path;
		
		return packagePathIdMap[path];
	}
	
	function bundleModule(module, context)
	{
		var canonicalId = module[0].replace(context.pkg[0], "");
		
		if (typeof self.options.existingModules !== "undefined" && 
			UTIL.isArrayLike(self.options.existingModules) && 
			self.options.existingModules.indexOf(module[0]) >= 0)
		{
			// Module to be added to this bundle is already in the existingModules list so we don't add again.
			return;
		}
		masterReport.bundleReport.modules[canonicalId] = module[0];

		return context.bundlerAdapter.encodeModule(module[0], canonicalId, module[1].staticLinks).then(function(code)
		{
			context.bundleStream.write('    require.memoize("' + context.pkgNamespace + canonicalId + '", ');
			context.bundleStream.write(code.replace(/^[\s\n]*/, "").split('\n').join('\n    '));
			context.bundleStream.write(');\n');
		}).then(function()
		{
			if (typeof context.pkgObj.descriptor.config !== "object" ||
				typeof context.pkgObj.descriptor.config["github.com/sourcemint/bundler-js/0/-meta/config/0"] !== "object" ||
				typeof context.pkgObj.descriptor.config["github.com/sourcemint/bundler-js/0/-meta/config/0"].resolvers !== "object")
			{
				if (module[1].dynamicLinks && UTIL.len(module[1].dynamicLinks) > 0) {
					throw new Error("Package descriptor '" + context.pkgObj.path + "/package.json' for module '" + module[0] + "' does not declare resolvers needed for 'require.async()' at 'config[\"github.com/sourcemint/bundler-js/0/-meta/config/0\"].resolvers'.");
				}
				return;
			}
			
			var done = Q.ref();
			
			// For each dynamic links look for a resolver in the package descriptor.
			var resolvers = context.pkgObj.descriptor.config["github.com/sourcemint/bundler-js/0/-meta/config/0"].resolvers[canonicalId];

			if (typeof resolvers === "undefined" || !UTIL.isArrayLike(resolvers))
			{
				if (module[1].dynamicLinks && UTIL.len(module[1].dynamicLinks) > 0) {
					throw new Error("Package descriptor '" + context.pkgObj.path + "/package.json' for module '" + module[0] + "' does not declare resolvers needed for 'require.async()' at 'config[\"github.com/sourcemint/bundler-js/0/-meta/config/0\"].resolvers[\"" + canonicalId + "\"] = []'.");
				}
				return;
			}

			// For each resolver build the requested bundles
			resolvers.forEach(function(resolver)
			{
				done = Q.when(done, function()
				{
					if (typeof resolver === "string")
					{
						var deferred = Q.defer();

						GLOB(context.pkg[0] + "/" + resolver, {
							cwd: context.pkg[0]
						}, function (err, files)
						{
							if (err) deferred.reject(err);
							else
							{
								files.forEach(function(file)
								{
									dynamicLoadBundles.push({
										uri: file,
										path: FS.realpathSync(context.pkg[0] + "/" + file)
									});
								});
								deferred.resolve();
							}
						});

						return deferred.promise;
					}
					else
						throw new Error("Resolver '" + resolver + "' in package descriptor '" + context.pkg[0] + "/package.json' not supported!");
				});
			});

			return done;
		});
	}
	
	function bundlePackage(pkg, context)
	{
		context = UTIL.copy(context);

		// If we are not dealing with the main package we need to alias modules into the canonical namespace for the bundle.
		context.pkgNamespace = "";
		if (pkg[0] !== masterReport.mappedReport.mainPackage)
		{
			context.pkgNamespace = packageIdForPath(pkg[0]);
		}
		context.pkg = pkg;

		return self.getInitializedPackageForPath(pkg[0]).then(function(pkgObj)
		{
			context.pkgObj = pkgObj;

			var pkgDescriptorId = "/package.json",
				descriptor = UTIL.deepCopy(pkgObj.descriptor);
			
			// Remove some stuff in the package descriptor that is irrelevant on the client now.
			// TODO: Use a setting to determine what to remove.
			if (descriptor.main) {
				descriptor.main = descriptor.main.replace(/^\.(\/)/, "$1");
			}
			if (typeof descriptor.config === "object") {
				delete descriptor.config["github.com/sourcemint/bundler-js/0/-meta/config/0"];
			}
			if (UTIL.len(descriptor.config) === 0) {
				delete descriptor.config;
			}

			packageDescriptors.push(function()
			{
				if (typeof descriptor.mappings === "object")
				{
					UTIL.forEach(descriptor.mappings, function(mapping)
					{
						// TODO: Use common resolver here.
						descriptor.mappings[mapping[0]] = packageIdForPath(FS.realpathSync(pkg[0] + "/" + mapping[1]));
					});
				}
				context.bundleStream.write('    require.memoize("' + context.pkgNamespace + pkgDescriptorId + '", ');
				context.bundleStream.write(JSON.stringify(descriptor).split('\n').join('\n    '));
				context.bundleStream.write(');\n');
			});

			var done = Q.ref();
			UTIL.forEach(pkg[1].modules, function(module)
			{
				done = Q.when(done, function()
				{
					return bundleModule(module, context);
				})
			});

			return Q.when(done, function()
			{
				if (typeof pkgObj.descriptor.config["github.com/sourcemint/bundler-js/0/-meta/config/0"].resources === "undefined" ||
					!UTIL.isArrayLike(pkgObj.descriptor.config["github.com/sourcemint/bundler-js/0/-meta/config/0"].resources))
				{
					return;
				}
				var done = Q.ref();
				pkgObj.descriptor.config["github.com/sourcemint/bundler-js/0/-meta/config/0"].resources.forEach(function(resource)
				{
					done = Q.when(done, function()
					{
						if (typeof resource === "string")
						{
							var done = Q.ref();

							GLOB(pkg[0] + "/" + resource, {
								cwd: pkg[0]
							}, function (err, files)
							{
								if (err) throw err;
								else
								{
									files.forEach(function(file)
									{
										if (FS.statSync(pkg[0] + "/" + file).isFile())
										{
											done = Q.when(done, function()
											{
												// TODO: If error happens here we should fail!

												var deferred = Q.defer();

												if (!PATH.existsSync(PATH.dirname(self.distributionPath + "/" + file))) {
													WRENCH.mkdirSyncRecursive(PATH.dirname(self.distributionPath + "/" + file), 0775);
												}
												
												var oldFile = FS.createReadStream(pkg[0] + "/" + file),
													newFile = FS.createWriteStream(self.distributionPath + "/" + file);

												newFile.once("close", function() {
													deferred.resolve();
												});
												
												newFile.once("open", function() {
												    require("util").pump(oldFile, newFile);
												});
												
												return deferred.promise;
											});
										}
									});
								}
							});

							return done;
						}
						else
							throw new Error("Resource '" + resource + "' in package descriptor '" + context.pkg[0] + "/package.json' not supported!");
					});
				});
				return done;
			});
		});
	}

	return Q.when(self.programPackage(), function(pkg)
	{
		return self.generateReport().then(function(sourceReport)
		{
			masterReport.sourceReport = sourceReport;

			var bundlerAdapter = pkg.loadAdapterImplFor(pkg.descriptor.config["github.com/sourcemint/bundler-js/0/-meta/config/0"].adapter, "bundler");

			return Q.when((typeof bundlerAdapter.remapSources === "function")?bundlerAdapter.remapSources(sourceReport):sourceReport).then(function(mappedReport)
			{
				masterReport.mappedReport = mappedReport;
				
				var bundlePath = self.distributionPath + ".js";

				masterReport.bundleReport.mainBundle = bundlePath;

				bundleStream = FS.createWriteStream(bundlePath, {
					flags: "w",
					encoding: "utf-8",
					mode: 0775
				});

				bundleStream.write('require.bundle("", function(require)\n{\n');

				if (typeof bundlerAdapter.getBundleHeader === "function")
				{
					bundleStream.write('    ' + bundlerAdapter.getBundleHeader().split('\n').join('\n    ') + '\n');
				}

				var done = Q.ref();
				
				UTIL.forEach(masterReport.mappedReport.packages, function(pkg)
				{
					done = Q.when(done, function()
					{
						return bundlePackage(pkg, {
							bundler: self,
							bundlerAdapter: bundlerAdapter,
							bundleStream: bundleStream
						});
					});
				});

				return Q.when(done, function()
				{
					packageDescriptors.forEach(function(packageDescriptor) {
						packageDescriptor();
					});
					
					bundleStream.write('});');
					bundleStream.end();

					return masterReport;
				}, function(err)
				{
					bundleStream.destroy();
					FS.unlinkSync(bundlePath);
					throw err;
				});
			}).then(function()
			{
				var done = Q.ref();

				dynamicLoadBundles.forEach(function(dynamicLoadBundle)
				{
					done = Q.when(done, function()
					{
						var options = UTIL.deepCopy(self.options);
						options.mainModule = dynamicLoadBundle.uri;
						options.existingModules = UTIL.values(masterReport.bundleReport.modules);

						var distPath = self.distributionPath + "/" + dynamicLoadBundle.uri.replace(/\.js$/, "");
						if (!PATH.existsSync(PATH.dirname(distPath))) {
							WRENCH.mkdirSyncRecursive(PATH.dirname(distPath), 0775);
						}

						return ((new Bundler(self.packagePath, distPath, options)).generateBundles());
					});
				});

				return done;
			});
		});
	});
}
