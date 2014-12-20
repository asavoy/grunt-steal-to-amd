// Good references for recast:
//
// see http://stackoverflow.com/questions/24784222/preprocessor-to-replace-javascript-keywords
// and https://github.com/phpro/grunt-es3-safe-recast/blob/master/tasks/es3_safe_recast.js
// and https://github.com/stefanpenner/es3-safe-recast/blob/master/package.json
//

'use strict';

var recast = require('recast');
var types = recast.types;
var namedTypes = types.namedTypes;
var util = require('util');

/**
 * Inspect an object prettily.
 */
var logInspect = function(obj) {
    console.log(util.inspect(obj, {
        colors: true,
        showHidden: true,
        depth: null
    }));
};

/**
 * Clone an object by converting to JSON and back.
 */
function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Transforms the source of a steal formatted module, into an AMD formatted
 * module. Makes no changes if not a steal formatted module.
 */
function transformSource(source, convertMap, convertExtensionsToPlugins) {
    // Parse into an AST.
    var ast = recast.parse(source);

    // Find the steal() header. It must be a top-level call.
    var stealExprStms = ast.program.body.filter(function(node) {
        return (
            node.type === 'ExpressionStatement'
            && node.expression.type === 'CallExpression'
            && node.expression.callee.type === 'Identifier'
            && node.expression.callee.name === 'steal'
        );
    });

    // Early exit if not a steal module.
    if (!stealExprStms.length) {
        console.warn('No steal header found');
        return source;
    }

    // Get the first steal call. Assume there's only one per module.
    var stealExprStm = stealExprStms[0];

    // Change arguments of the call, by wrapping with an array, from:
    //
    //    steal(
    //          dep1,
    //          dep2,
    //          depN,
    //          function(...) {
    //              ...
    //          })
    //
    // into:
    //
    //    define([
    //          dep1,
    //          dep2,
    //          depN
    //    ], function(...) {
    //          ...
    //    ));
    //
    // Another case to handle:
    //
    //    steal(dep1, dep2, function(...) {
    //          ...
    //    });
    //
    // into:
    //
    //    define([dep1, dep2], function(...) {
    //          ...
    //    });
    //

    // Rename "steal()" to "define()".
    stealExprStm.expression.callee.name = 'define';

    // This is the function call.
    var callExpr = stealExprStm.expression;

    // The last argument...
    var lastArg = callExpr.arguments[callExpr.arguments.length - 1];

    // The last argument should be a function call...
    var funcArg = null;
    if (lastArg.type === 'FunctionExpression') {
        funcArg = lastArg;
    }

    // Now get all the other args, they should be names of the dependencies.
    var depArgs = callExpr.arguments.filter(function(node) {
        return node !== funcArg;
    });

    // Keep a reference to the last dependency argument.
    var lastDep = depArgs[depArgs.length - 1];

    // Were all the arguments on the same line?
    var depArgsWereOnSingleLine = (
        depArgs.length
        && depArgs[0].loc.start.line == lastDep.loc.start.line
    );

    // We want to insert an Array expression with the dependency args in it.
    // Unfortunately, recast doesn't let us control the formatting/whitespace
    // printed directly. But... it does keep original formatting/whitespace
    // quite well... so if we create a source string formatted the way we like
    // it, we can parse the AST with recast and thus control
    // formatting/whitespace in this round-about way.
    var newArraySourceLines = ['[', ']'];
    depArgs.forEach(function(value, index) {
        var isLastItem = (index == depArgs.length - 1);
        var fakeArg = depArgsWereOnSingleLine
            ? '"REPLACE_ME"'
            : '    "REPLACE_ME"';
        if (isLastItem) {
            newArraySourceLines.splice(newArraySourceLines.length - 1, 0, fakeArg);
        }
        else {
            newArraySourceLines.splice(newArraySourceLines.length - 1, 0, fakeArg + ', ');
        }
    });

    var newArraySource;
    if (depArgsWereOnSingleLine) {
        newArraySource = newArraySourceLines.join('');
    }
    else {
        newArraySource = newArraySourceLines.join('\n');
    }
    var newArrayAst = recast.parse(newArraySource);
    var newArrayExpr = newArrayAst.program.body[0].expression;

    // Replace each of the items in the sample array, with the dependency
    // arguments.
    depArgs.forEach(function(depArg, index) {
        newArrayExpr.elements[index] = depArg;
    });

    // Now insert the sampleArray into the define() call expression,
    // replacing where the original dependency args went.
    callExpr.arguments.splice(0, depArgs.length, newArrayExpr);

    // Takes a StealJS dependency name and converts to a RequireJS dependency
    // name.
    var convertToRequireJSDependency = function(name) {
        // Special cases.
        if (convertMap[name]) {
            return convertMap[name];
        }
        // Change any modules to use plugins.
        // e.g. "views/page.mustache!" => "mustache!views/page.mustache".
        for (var extension in convertExtensionsToPlugins) {
            var plugin = convertExtensionsToPlugins[extension];
            // Does name end with extension?
            if (name.slice(-extension.length) === extension) {
                return plugin + name.replace('!', '');
            }
        }
        // Change "path/name.js" => "path/name".
        // Does name end with ".js"?
        var jsExtension = '.js';
        if (name.slice(-jsExtension.length) === jsExtension) {
            return name.replace('.js', '');
        }
        // No change for relative paths: "./path/name" => "./path/name"
        var relativePrefix = './';
        var pluginSuffix = '!';
        // Does name start with a relative path?
        if (name.slice(0, relativePrefix.length) === relativePrefix) {
            // Does it not use a plugin?
            if (name.slice(-pluginSuffix.length) !== pluginSuffix) {
                return name;
            }
        }
        // Lastly, change "path/name" => "path/name/name".
        var depParts = name.split('/');
        depParts.push(depParts[depParts.length - 1]);
        return depParts.join('/');
    };

    // So remember how we can't set recast formatting? That includes whether
    // strings are printed with single-quotes or double-quotes. We prefer
    // single-quotes so we have to use the round-about method again here.
    var buildStringExpr = function(stringValue) {
        var stringAst = recast.parse("'" + stringValue + "'");
        return stringAst.program.body[0].expression;
    };

    // Go through the new Array, converting each StealJS dependency into a
    // RequireJS-friendly dependency.
    newArrayExpr.elements.forEach(function(depArg, index) {
        var argExpr = buildStringExpr(convertToRequireJSDependency(depArg.value));
        newArrayExpr.elements[index] = argExpr;
    });

    // Reprint the modified AST.
    var transformedSource = recast.print(ast).code;

    // Rename "steal:false" in the globals header to "define:false".
    var transformedSourceParts = transformedSource.split('*/');
    transformedSourceParts.forEach(function(sourcePart, index) {
        // Does this section contain the globals header?
        if (sourcePart.indexOf('/*global') !== -1) {
            transformedSourceParts[index] = sourcePart.replace(/\bsteal:( ?false)/, 'define:$1', 1);
        }
    });
    transformedSource = transformedSourceParts.join('*/');

    return transformedSource;
}


module.exports = function(grunt) {

    grunt.registerMultiTask(
        'stealToAmd',
        'Rewrite StealJS modules into AMD',
        function() {
            // Merge task-specific and/or target-specific options with these
            // defaults.
            var options = this.options({
                convertExtensionsToPlugins: {
                    '.css!': 'css!',
                    '.ejs!': 'ejs!',
                    '.mustache!': 'mustache!',
                    '.stache!': 'stache!'
                },
                convertMap: {
                    'can': 'can',
                    'can/component': 'can/component',
                    'can/compute': 'can/compute',
                    'can/construct': 'can/construct',
                    'can/construct/proxy': 'can/construct/proxy',
                    'can/construct/super': 'can/construct/super',
                    'can/control': 'can/control',
                    'can/control/plugin': 'can/control/plugin',
                    'can/control/route': 'can/control/route',
                    'can/control/view': 'can/control/view',
                    'can/list': 'can/list',
                    'can/list/promise': 'can/list/promise',
                    'can/map': 'can/map',
                    'can/map/sort': 'can/map/sort',
                    'can/map/attributes': 'can/map/attributes',
                    'can/map/define': 'can/map/define',
                    'can/map/delegate': 'can/map/delegate',
                    'can/map/elements': 'can/map/elements',
                    'can/model': 'can/model',
                    'can/model/list': 'can/model/list',
                    'can/observe': 'can/observe',
                    'can/observe/backup': 'can/observe/backup',
                    'can/observe/validations': 'can/observe/validations',
                    'can/route': 'can/route',
                    'can/view': 'can/view',
                    'can/view/bindings': 'can/view/bindings',
                    'can/view/ejs': 'can/view/ejs',
                    'can/view/live': 'can/view/live',
                    'can/view/micro': 'can/view/micro',
                    'can/view/modifiers': 'can/view/modifiers',
                    'can/view/mustache': 'can/view/mustache',
                    // NOTE: Have to map this to can/util/jquery, or submodules
                    //       paths will break.
                    'can/util': 'can/util/jquery',
                    'can/util/array/makeArray.js': 'can/util/array/makeArray.js',
                    'can/util/fixture': 'can/util/fixture',
                    'can/util/string/deparam': 'can/util/string/deparam',
                    'jquery': 'jquery',
                    'funcunit': 'funcunit',
                    'funcunit/qunit': 'qunit'
                },
                ignorePaths: [
                    'src/can/',
                    'src/documentjs/',
                    'src/funcunit/',
                    'src/steal/'
                ],
                maxFiles: null
            });

            // Iterate over each file.
            var filesCompleted = 0;
            this.files.forEach(function(file) {
                file.src.forEach(function(filePath) {
                    // To limit processing to first N files.
                    if (options.maxFiles && (filesCompleted > options.maxFiles)) {
                        return;
                    }
                    // Ignore files that match ignorePaths.
                    for (var i=0; i<options.ignorePaths.length; i++) {
                        var ignorePath = options.ignorePaths[i];
                        // Does filePath start with ignorePath?
                        if (filePath.slice(0, ignorePath.length) === ignorePath) {
                            grunt.log.writeln('Ignoring: ' + filePath);
                            return;
                        }
                    }
                    // Transform source for each file.
                    grunt.log.writeln('Processing: ' + filePath);
                    var content = grunt.file.read(filePath);
                    var newContent = transformSource(
                        content,
                        options.convertMap,
                        options.convertExtensionsToPlugins
                    );
                    // Overwrite the original file.
                    grunt.file.write(filePath, newContent);
                    filesCompleted += 1;
                });
            });

        });
};
