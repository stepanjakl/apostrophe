// Implements template rendering via Nunjucks. **You should use the
// `self.render` method of *your own* module**,
// which exist courtesy of
// [@apostrophecms/module](../@apostrophecms/module/index.html) and invoke
// methods of this module more conveniently for you.
//
// You may have occasion to call `self.apos.template.safe` when
// implementing a helper that returns a value that should not be
// escaped by Nunjucks. You also might call `self.apos.template.filter` to
// add a new filter to Nunjucks.
//
// ## Options
//
// ### `filters`: an object in which
// each key is the name of a Nunjucks filter and
// its corresponding value is a function that implements it.
// You may find it easier and more maintainable to call
// `apos.template.addFilter(name, fn)`.
//
// ### `language`: your own alternative to the object
// returned by require('nunjucks'). Replacing Nunjucks
// entirely in Apostrophe would be a vast undertaking, but perhaps
// you have a custom version of Nunjucks that is compatible.
//
// ### `viewsFolderFallback`: specifies a folder to be checked for templates
// if they are not found in the module that called `self.render`
// or those it extends. This is a handy place for project-wide macro files.
// Often set to `__dirname + '/views'` in `app.js`.

const _ = require('lodash');
const dayjs = require('dayjs');
const qs = require('qs');
const Promise = require('bluebird');
const path = require('path');
const { stripIndent } = require('common-tags');
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions');
const voidElements = require('void-elements');

module.exports = {
  options: { alias: 'template' },
  customTags(self) {
    return {
      component: require('./lib/custom-tags/component')(self),
      fragment: require('./lib/custom-tags/fragment')(self),
      // render & rendercall
      ...require('./lib/custom-tags/render')(self)
    };
  },
  components(self) {
    return {
      async inject(req, data) {
        const key = `${data.end}-${data.where}`;
        const components = self.getInjectedComponents(key, data);
        const html = data.when ? '' : self.injectNodes(req, key);

        return {
          components,
          html
        };
      }
    };
  },
  init(self) {
    self.templateApos = {
      modules: {},
      log: function (msg) {
        self.apos.util.log.apply(self.apos, arguments);
      },
      prefix: self.apos.prefix
    };

    self.envs = {};
    self.filters = {};
    self.nunjucks = self.options.language || require('nunjucks');
    self.insertions = {};
    self.runtimeNodes = {};

  },
  handlers(self) {
    return {
      'apostrophe:ready': {
        wrapHelpersForTemplateAposObject() {
          wrapFunctions(self.templateApos);
          _.each(self.templateApos.modules, function (helpers, moduleName) {
            const alias = self.apos.modules[moduleName].options.alias;
            if (alias) {
              if (_.has(self.templateApos, alias)) {
                throw new Error('The module ' + moduleName + ' has the alias ' + alias + ' which conflicts with core functionality. Change the alias.');
              }
              self.templateApos[alias] = helpers;
            }
          });
          _.each(self.templateApos.modules, function (helpers, moduleName) {
            helpers.options = self.apos.modules[moduleName].options;
          });

          function wrapFunctions(object) {
            _.each(object, function (value, key) {
              if (typeof value === 'object') {
                wrapFunctions(value);
              } else if (typeof value === 'function') {
                object[key] = function () {
                  try {
                    return value.apply(self, arguments);
                  } catch (e) {
                    self.apos.util.error(e);
                    self.apos.util.error(e.stack);
                    self.apos.util.error('^^^^^ LOOK UP HERE FOR THE LOCATION WITHIN YOUR HELPER');
                    throw e;
                  }
                };
              }
            });
          }
        }
      },
      'apostrophe:destroy': {
        async nunjucksLoaderCleanup() {
          for (const loader of Object.values(self.loaders || {})) {
            await loader.destroy();
          }
        }
      }
    };
  },
  methods(self) {
    return {
      ...require('./lib/bundlesLoader')(self),

      // Add helpers in the namespace for a particular module.
      // They will be visible in nunjucks at
      // apos.modules[module-name].helperName. If the alias
      // option for the module is set to "shortname", then
      // they are also visible as apos.shortname.helperName.
      // Note that the alias option must be set only by the
      // project-level developer (except for core modules).

      addHelpersForModule(module, object) {
        const helpersForModules = self.templateApos.modules;
        helpersForModules[module.__meta.name] =
          helpersForModules[module.__meta.name] || {};
        const helpersForModule = helpersForModules[module.__meta.name];
        if (typeof object === 'string') {
          helpersForModule[arguments[1]] = arguments[2];
        } else {
          _.merge(helpersForModule, object);
        }
      },

      // Add new filters to the Nunjucks environment. You
      // can add many by passing an object with named
      // properties, or add just one by passing a name
      // and a function. You can also do this through the
      // filters option of this module.

      addFilter(object) {
        if (typeof object === 'string') {
          self.filters[arguments[0]] = arguments[1];
        } else {
          _.extend(self.filters, object);
        }
      },

      // return a string which will not be escaped
      // by Nunjucks. Call this in your helper function
      // when your return value contains markup and you
      // are absolutely sure that any user input has
      // been correctly escaped already.

      safe(s) {
        return new self.nunjucks.runtime.SafeString(s);
      },

      // Escape any HTML markup in the given string and return a new Nunjucks
      // safe string, unless it is already marked as safe by Nunjucks. If it is
      // nullish treat it as an empty string. If it is not a string convert it
      // with its `toString` method before escaping.

      escapeIfNeeded(s) {
        if (!(s instanceof self.nunjucks.runtime.SafeString)) {
          return self.safe(self.apos.util.escapeHtml((s == null) ? '' : s.toString()));
        } else {
          return s;
        }
      },

      // Load and render a Nunjucks template, internationalized
      // by the given req object. The template with the name
      // specified is loaded from the views folder of the
      // specified module or its superclasses; the deepest
      // version of the template wins. You normally won't call
      // this directly; you'll call self.render on your module.

      // Apostrophe Nunjucks helpers such as `apos.area` are
      // attached to the `apos` object in your template.

      // Data passed in your `data` object is provided as the
      // `data` object in your template, which also contains
      // properties of `req.data` and `module.templateData`,
      // if those objects exist.

      // If there is a conflict, your `data` argument wins,
      // followed by `req.data`.

      // If not overridden, `data.user` is provided for convenience.

      // If there is no extension, looks for `.njk`, or `.html`
      // if `.njk` is not found.

      // Must be awaited (async function).

      async renderForModule(req, name, data, module) {
        if (typeof req !== 'object') {
          throw new Error('The first argument to module.render must be req.');
        }
        return self.renderBody(req, 'file', name, data, module);
      },

      // Works just like self.render, except that the
      // entire template is passed as a string rather than
      // a filename.

      async renderStringForModule(req, s, data, module) {
        if (typeof req !== 'object') {
          throw new Error('The first argument to module.render must be req.');
        }
        return self.renderBody(req, 'string', s, data, module);
      },

      // Stringify the data as JSON, then escape any sequences
      // that would cause a `script` tag to end prematurely if
      // the JSON were embedded in it. Also make sure the JSON is
      // JS-friendly by escaping unicode line and paragraph
      // separators.
      //
      // If the argument is `undefined`, `"null"` is returned. This is
      // better than the behavior of JSON.stringify (which returns
      // `undefined`, not "undefined") while still being JSONic
      // (`undefined` is not valid in JSON).

      jsonForHtml(data) {
        if (data === undefined) {
          return 'null';
        }
        data = JSON.stringify(data);
        // , null, '  ');
        data = data.replace(/<!--/g, '<\\!--');
        data = data.replace(/<\/script>/gi, '<\\/script>');
        // unicode line separator and paragraph separator break JavaScript
        // parsing
        data = data.replace(/\u2028/g, '\\u2028');
        data = data.replace(/\u2029/g, '\\u2029');
        return data;
      },

      // Implements `render` and `renderString`. See their
      // documentation. async function.

      async renderBody(req, type, s, data, module) {

        let result;

        const args = self.getRenderArgs(req, data, module);

        const env = self.getEnv(req, module);

        if (type === 'file') {
          let finalName = s;
          if (!finalName.match(/\.\w+$/)) {
            finalName += '.html';
          }
          result = await Promise.promisify(function (finalName, args, callback) {
            return env.getTemplate(finalName).render(args, callback);
          })(finalName, args);
        } else if (type === 'string') {
          result = await Promise.promisify(function (s, args, callback) {
            return env.renderString(s, args, callback);
          })(s, args);
        } else {
          throw new Error('renderBody does not support the type ' + type);
        }
        return result;
      },

      // Implementation detail of `renderBody` responsible for
      // creating the input object passed to the template engine e.g. Nunjucks.
      // Includes both serializable data like `user` and non-JSON-friendly
      // properties like `apos`, `getOptions()` and `__req`. If you are only
      // interested in serializable data use `getRenderDataArgs`

      getRenderArgs(req, data, module) {
        const args = {
          data: self.getRenderDataArgs(req, data, module)
        };
        args.apos = self.templateApos;
        args.__t = req.t;
        args.__ = key => {
          self.apos.util.warnDevOnce('old-i18n-nunjucks-helper', stripIndent`
            The __() Nunjucks helper is deprecated and does not localize in A3.
            Use __t() instead.
          `);
          return key;
        };
        args.__req = req;
        args.getOption = (key, def) => {
          const colonAt = key.indexOf(':');
          let optionModule = self.apos.modules[module.__meta.name];
          if (colonAt !== -1) {
            const name = key.substring(0, colonAt);
            key = key.substring(colonAt + 1);
            optionModule = self.apos.modules[name];
          }
          return optionModule.getOption(req, key, def);
        };
        return args;
      },

      // Just the external front-compatible parts of `getRenderArgs` that
      // go into `args.data` for Nunjucks, e.g. merging `req.data` and `data`,
      // adding `req.user` as `user`, etc.

      getRenderDataArgs(req, data, module) {
        const merged = {};

        if (data) {
          _.defaults(merged, data);
        }

        if (req.data) {
          _.defaults(merged, req.data);
        }
        _.defaults(merged, {
          user: req.user,
          permissions: (req.user && req.user._permissions) || {}
        });

        if (module.templateData) {
          _.defaults(merged, module.templateData);
        }

        merged.locale = merged.locale || req.locale;
        return merged;
      },

      // Fetch a nunjucks environment in which `include`, `extends`, etc. search
      // the views directories of the specified module and its ancestors.
      // Typically you will call `self.render` on your module
      // object rather than calling this directly.
      //
      // `req` is effectively here for bc purposes only. This method
      // does NOT always pass `req` to `newEnv` for every new release, as
      // `req` is separately supplied to each request to fix a memory leak
      // that occurs when Nunjucks environments are created for every request.

      getEnv(req, module) {
        const name = module.__meta.name;
        if (!_.has(self.envs, name)) {
          // Pass the original req for bc purposes only,
          // note that due to the reuse of envs there is
          // no guarantee newEnv will be called for every req
          self.envs[name] = self.newEnv(req, name, self.getViewFolders(module));
        }
        return self.envs[name];
      },

      getViewFolders(module) {
        const dirs = _.map(module.__meta.chain, function (entry) {
          return entry.dirname + '/views';
        });
        // Final class should win
        dirs.reverse();

        const viewsFolderFallback = self.options.viewsFolderFallback ||
          path.join(self.apos.rootDir, 'views');

        dirs.push(viewsFolderFallback);

        return dirs;
      },

      // Create a new nunjucks environment in which the
      // specified directories are searched for includes,
      // etc. Don't call this directly, use:
      //
      // apos.template.getEnv(req, module)
      //
      // `req` is effectively here for bc purposes only. Apostrophe
      // does NOT always pass `req` to `newEnv` for every new release, as
      // `req` is separately supplied to each request to fix a memory leak
      // that occurs when Nunjucks environments are created for every request.
      // If you must access `req` in a custom Nunjucks tag use
      // `context.ctx.__req`, NOT `env.opts.req` which is no longer provided.

      newEnv(req, moduleName, dirs) {

        const loader = self.getLoader(moduleName, dirs);

        const env = new self.nunjucks.Environment(loader, {
          autoescape: true,
          module: self.apos.modules[moduleName]
        });

        env.addGlobal('apos', self.templateApos);
        env.addGlobal('module', self.templateApos.modules[moduleName]);

        self.addStandardFilters(env);

        _.each(self.filters, function (filter, name) {
          env.addFilter(name, filter);
        });

        if (self.options.filters) {
          _.each(self.options.filters, function (filter, name) {
            env.addFilter(name, filter);
          });
        }

        _.each(self.apos.modules, function (module, name) {
          if (module.customTags) {
            _.each(module.customTags, function (config, tagName) {
              env.addExtension(tagName, configToExtension(tagName, config));
            });
          }
        });

        function configToExtension(name, config) {
          // Legacy glue to create a Nunjucks custom tag extension from our
          // async/await-friendly, simplified format
          const extension = {};
          extension.tags = [ name ];
          extension.parse = function (parser, nodes, lexer) {
            const parse = config.parse
              ? config.parse
              : function (parser, nodes, lexer) {
              // Default parser gets comma separated arguments,
              // assumes no body

                // get the tag token
                const token = parser.nextToken();
                // parse the args and move after the block end. passing true
                // as the second arg is required if there are no parentheses
                const args = parser.parseSignature(null, true);
                parser.advanceAfterBlockEnd(token.value);
                return { args };
              };
            const parsed = parse(parser, nodes, lexer);
            return new nodes.CallExtensionAsync(extension, 'run', parsed.args, parsed.blocks || []);
          };
          extension.run = async function (context) {
            const callback = arguments[arguments.length - 1];
            try {
              // Pass req, followed by other args that are not "context" (first)
              // or "callback" (last)
              const args = [
                context,
                ...[].slice.call(arguments, 1, arguments.length - 1)
              ];
              const result = await config.run.apply(config, args);
              return callback(null, self.apos.template.safe(result));
            } catch (e) {
              return callback(e);
            }
          };
          return extension;
        }

        return env;
      },

      // Creates a Nunjucks loader object for the specified
      // list of directories, which can also call back to
      // this module to resolve cross-module includes. You
      // will not need to call this directly.

      newLoader(moduleName, dirs) {
        const NunjucksLoader = require('./lib/nunjucksLoader.js');
        return new NunjucksLoader(moduleName, dirs, undefined, self, self.options.loader);
      },

      // Wrapper for newLoader with caching. You will not need
      // to call this directly.

      getLoader(moduleName, dirs) {
        const key = JSON.stringify({
          moduleName,
          dirs
        });
        if (!self.loaders) {
          self.loaders = {};
        }
        if (!self.loaders[key]) {
          self.loaders[key] = self.newLoader(moduleName, dirs);
        }
        return self.loaders[key];
      },

      addStandardFilters(env) {

        // Format the given date with the given moment.js
        // format string.

        env.addFilter('date', function (date, format) {
          // Nunjucks is generally highly tolerant of bad
          // or missing data. Continue this tradition by not
          // crashing if date is null. -Tom
          if (!date) {
            return '';
          }
          const s = dayjs(date).format(format);
          return s;
        });

        // Stringify the given data as a query string.

        env.addFilter('query', function (data) {
          return qs.stringify(data || {});
        });

        // Stringify the given data as JSON, with
        // additional escaping for safe inclusion
        // in a script tag.

        env.addFilter('json', function (data) {
          return self.safe(self.jsonForHtml(data));
        });

        // Builds filter URLs. See the URLs module.

        env.addFilter('build', self.apos.url.build);

        // Remove HTML tags from string, leaving only
        // the text. All lower case to match jinja2's naming.

        env.addFilter('striptags', function (data) {
          return data.replace(/(<([^>]+)>)/ig, '');
        });

        // Convert newlines to <br /> tags.
        env.addFilter('nlbr', function (data) {
          data = self.escapeIfNeeded(data);
          data = self.apos.util.globalReplace(data.toString(), '\n', '<br />\n');
          return self.safe(data);
        });

        // Newlines to paragraphs, produces better spacing and semantics
        env.addFilter('nlp', function (data) {
          data = self.escapeIfNeeded(data);
          const parts = data.toString().split(/\n/);
          const output = _.map(parts, function (part) {
            return '<p>' + part + '</p>\n';
          }).join('');
          return self.safe(output);
        });

        // Convert the camelCasedString s to a hyphenated-string,
        // for use as a CSS class or similar.
        env.addFilter('css', function (s) {
          return self.apos.util.cssName(s);
        });

        env.addFilter('clonePermanent', function (o, keepScalars) {
          return self.apos.util.clonePermanent(o, keepScalars);
        });

        // Output "data" as JSON, escaped to be safe in an
        // HTML attribute. By default it is escaped to be
        // included in an attribute quoted with double-quotes,
        // so all double-quotes in the output must be escaped.
        // If you quote your attribute with single-quotes
        // and pass { single: true } to this filter,
        // single-quotes in the output are escaped instead,
        // which uses dramatically less space and produces
        // more readable attributes.
        //
        // EXCEPTION: if the data is not an object or array,
        // it is output literally as a string. This takes
        // advantage of jQuery .data()'s ability to treat
        // data attributes that "smell like" objects and arrays
        // as such and take the rest literally.

        env.addFilter('jsonAttribute', function (data, options) {
          if (typeof data === 'object') {
            return self.safe(self.apos.util.escapeHtml(JSON.stringify(data), options));
          } else {
            // Make it a string for sure
            data += '';
            return self.safe(self.apos.util.escapeHtml(data, options));
          }
        });

        env.addFilter('merge', function (data) {
          const output = {};
          let i;
          for (i = 0; i < arguments.length; i++) {
            _.assign(output, arguments[i]);
          }
          return output;
        });

      },

      // Typically you will call the `sendPage` method of
      // your own module, provided by the `@apostrophecms/module`
      // base class, which is a wrapper for this method.
      //
      // Send a complete HTML page for to the
      // browser.
      //
      // `template` is a nunjucks template name, relative
      // to the provided module's views/ folder.
      //
      // `data` is provided to the template, with additional
      // default properties as described below.
      //
      // `module` is the module from which the template should
      // be rendered, if an explicit module name is not part
      // of the template name.
      //
      // Additional properties merged with the `data object:
      //
      // "outerLayout" is set to...
      //
      // `@apostrophecms/template:outerLayout.html`
      //
      // Or:
      //
      // `@apostrophecms/template:refreshLayout.html`
      //
      // This allows the template to handle either a content area
      // refresh or a full page render just by doing this:
      //
      // `{% extend outerLayout %}`
      //
      // Note the lack of quotes.
      //
      // If `req.query.aposRefresh` is `'1'`,
      // `refreshLayout.html` is used in place of `outerLayout.html`.
      //
      // These default properties are also provided on the `data` object
      // visible in Nunjucks:
      //
      // * `url` (`req.url`)
      // * `user` (`req.user`)
      // * `query` (`req.query`)
      // * `permissions` (`req.user._permissions`)
      // * `refreshing` (true if we are refreshing
      // the content area of the page without reloading)
      //
      // async function.

      async renderPageForModule(req, template, data, module) {
        const telemetry = self.apos.telemetry;
        const spanName = `render:${self.__meta.name}:renderPageForModule`;
        return telemetry.startActiveSpan(spanName, async (span) => {
          span.setAttributes({
            [SemanticAttributes.CODE_FUNCTION]: 'renderPageForModule',
            [SemanticAttributes.CODE_NAMESPACE]: self.__meta.name
          });
          span.setAttribute(telemetry.Attributes.TEMPLATE, template);

          const aposBodyData = await self.getBodyData(req);
          span.setAttribute(telemetry.Attributes.SCENE, aposBodyData.scene);

          self.addBodyDataAttribute(req, { apos: JSON.stringify(aposBodyData) });

          // Always the last call; signifies we're done initializing the
          // page as far as the core is concerned; a lovely time for other
          // modules and project-level javascript to do their own
          // enhancements.
          //
          // This method emits a 'ready' event, and also
          // emits an 'enhance' event with the entire $body
          // as its argument.
          //
          // Waits for DOMready to give other
          // things maximum opportunity to happen.

          const decorate = req.query.aposRefresh !== '1';

          // data.url will be the original requested page URL, for use in
          // building relative links, adding or removing query parameters, etc.
          // If this is a refresh request, we remove that so that frontend
          // templates don't build URLs that also refresh

          const args = {
            outerLayout: decorate ? '@apostrophecms/template:outerLayout.html' : '@apostrophecms/template:refreshLayout.html',
            permissions: req.user && (req.user._permissions || {}),
            scene: aposBodyData.scene,
            refreshing: !decorate,
            // Make the query available to templates for easy access to
            // filter settings etc.
            query: req.query,
            url: unrefreshed(req.prefix + req.url)
          };

          _.extend(args, data);

          if (req.aposError) {
          // A 500-worthy error occurred already, i.e. in `pageBeforeSend`
            telemetry.handleError(span, req.aposError);
            span.end();
            return error(req.aposError);
          }

          try {
            const spanRenderName = `render:${module.__meta.name}:render`;
            const content = await telemetry.startActiveSpan(
              spanRenderName,
              async (spanRender) => {
                spanRender.setAttribute(SemanticAttributes.CODE_FUNCTION, 'render');
                spanRender.setAttribute(
                  SemanticAttributes.CODE_NAMESPACE,
                  module.__meta.name
                );
                spanRender.setAttribute(telemetry.Attributes.SCENE, aposBodyData.scene);
                spanRender.setAttribute(telemetry.Attributes.TEMPLATE, template);

                try {
                  const content = await module.render(req, template, args);
                  spanRender.setStatus({ code: telemetry.api.SpanStatusCode.OK });
                  const filledContent = self.insertBundlesMarkup({
                    page: req.data.bestPage,
                    scene: aposBodyData.scene,
                    template,
                    content,
                    scriptsPlaceholder: req.scriptsPlaceholder,
                    stylesheetsPlaceholder: req.stylesheetsPlaceholder,
                    widgetsBundles: req.widgetsBundles
                  });
                  return filledContent;
                } catch (err) {
                  telemetry.handleError(spanRender, err);
                  throw err;
                } finally {
                  spanRender.end();
                }
              }, span);

            span.setStatus({ code: telemetry.api.SpanStatusCode.OK });
            return content;
          } catch (e) {
          // The page template threw an exception. Log where it
          // occurred for easier debugging
            telemetry.handleError(span, e);
            return error(e);
          } finally {
            span.end();
          }
        });

        function error(e) {
          self.logError(req, e);
          req.statusCode = 500;
          return self.render(req, 'templateError');
        }

        function unrefreshed(url) {
          // Including aposRefresh=1 in data.url leads to busted pages in
          // navigation links, so strip that out. However this is invoked on
          // every page load so do it as quickly as we can to avoid the
          // overhead of a full parse and rebuild
          if (!url.includes('aposRefresh=1')) {
            return url;
          } else if (url.endsWith('?aposRefresh=1')) {
            return url.replace('?aposRefresh=1', '');
          } else if (url.includes('?aposRefresh=1')) {
            return url.replace('?aposRefresh=1&', '?');
          } else {
            return url.replace('&aposRefresh=1', '');
          }
        }
      },

      async getBodyData(req) {
        let scene = req.user ? 'apos' : 'public';
        if (req.scene) {
          scene = req.scene;
        } else {
          req.scene = scene;
        }

        const aposBodyData = {
          modules: {},
          prefix: req.prefix,
          sitePrefix: self.apos.prefix,
          shortName: self.apos.shortName,
          locale: req.locale,
          csrfCookieName: self.apos.csrfCookieName,
          tabId: self.apos.util.generateId(),
          uploadsUrl: self.apos.attachment.uploadfs.getUrl(),
          assetBaseUrl: self.apos.asset.getAssetBaseUrl(),
          scene
        };
        if (req.user) {
          aposBodyData.user = {
            title: req.user.title,
            _id: req.user._id,
            username: req.user.username
          };
        }
        await self.emit('addBodyData', req, aposBodyData);

        return aposBodyData;
      },

      // Log the given template error with timestamp and user information
      logError(req, e) {
        let now = Date.now();
        now = dayjs(now).format('YYYY-MM-DDTHH:mm:ssZZ');
        self.apos.util.error(`:: ${now}: template error at ${req.url}`);
        self.apos.util.error(`Current user: ${req.user ? req.user.username : 'none'}`);
        self.apos.util.error(e);
      },

      // Add a body class or classes to be emitted when the page is rendered.
      // This information is attached to `req.data`, where the string
      // `req.data.aposBodyClasses` is built up. The default
      // `outerLayoutBase.html` template outputs that string. The string passed
      // may contain space-separated class names.

      addBodyClass(req, bodyClass) {
        req.data.aposBodyClasses = (req.data.aposBodyClasses ? req.data.aposBodyClasses + ' ' : '') + bodyClass;
      },

      // Add a body attribute to be emitted when the page is rendered. This
      // information is attached to `req.data`, where
      // `req.data.aposBodyDataAttributes` is built up using `name` as the
      // attribute name which is automatically prepended with "data-" and the
      // optional `value` argument.
      //
      // Alternatively the second argument may be an object, in which case each
      // property becomes a data attribute, with the `data-` prefix.
      //
      // The default `outerLayoutBase.html` template outputs
      // the data attributes on the `body` tag.

      addBodyDataAttribute(req, name, value) {
        let values = {};
        if (_.isObject(name) && !_.isArray(name) && !_.isFunction(name)) {
          values = name;
        } else {
          if (
            name &&
            name.toString().length > 0 &&
            value &&
            value.toString().length > 0
          ) {
            values[name] = value;
          }
        }
        _.each(values, (value, key) => {
          if (_.isEmpty(key)) {
            return;
          }
          // Single quotes are used to avoid unreadably massive data attributes
          // as double quotes are so common when the value is JSON
          req.data.aposBodyDataAttributes = (req.data.aposBodyDataAttributes ? req.data.aposBodyDataAttributes + ' ' : ' ') + ('data-' + (!_.isUndefined(value) && value.toString().length > 0 ? self.apos.util.escapeHtml(key) + (`='${self.apos.util.escapeHtml(value, { single: true })}'`) : self.apos.util.escapeHtml(key)));
        });
      },

      // Use this method to provide an async component name that will
      // be invoked at the point in the page layout identified by the string
      // `location`. Standard locations are `head`, `body`, and `main`.
      //
      //  The page layout, template or outerLayout must contain a corresponding
      // `{% component '@apostrophecms/template:inject', 'location', 'prepend'
      // %}` call, with the same location, to actually insert the content.
      //
      // The output of components added with `prepend` is prepended just after
      // the opening tag of an element, such as `<head>`. Use `append` to insert
      // material before the closing tag.
      //
      // This method is most often used when writing a module that adds new UI
      // to Apostrophe and allows you to add that markup without forcing
      // developers to customize their layout for your module to work.
      //
      // `conditions` argument can be an object with keys `when` and `bundler`
      // to specify when the component should be injected. `bundler` is the
      // alias of the currently registered asset external build module. For now
      // only `when: hmr` and `bundler: xxx` are supported.
      //
      // A new single argument signature is also supported, where the first
      // argument is an object. See `insert()` for more details.
      // Usage:
      // apos.template.prepend({
      //   component: 'module-name:async-component-name',
      //   where: 'head',
      //   when: 'hmr', // or e.g. ['hmr', 'dev'], logical AND
      //   bundler: 'vite',
      // });
      // OR
      // apos.template.prepend('head', 'module-name:async-component-name',
      // { when: 'hmr', bundler: 'vite' });
      // Such calls will match the following inject:
      // {% component '@apostrophecms/template:inject', 'head', 'prepend',
      // { when: 'hmr', bundler: 'vite' } %}
      // but only when the current asset bundler is 'vite'.

      prepend(location, componentName, conditions) {
        if (location && typeof location === 'object') {
          componentName = location.component;
        }
        if (typeof componentName !== 'string') {
          throw new Error('Do not pass a function to apos.template.prepend. Pass a fully qualified component name, i.e. module-name:async-component-name');
        }
        return self.insert('prepend', location, componentName, conditions);
      },

      // Use this method to provide an async component name that will
      // be invoked at the point in the page layout identified by the string
      // `location`. Standard locations are `head`, `body`, and `main`.
      //
      //  The page layout, template or outerLayout must contain a corresponding
      // `apos.template.prepended('location')` call, with the same location, to
      // actually insert the content.
      //
      // The output of components added with `append` is appended just before
      // the closing tag of an element, such as `</head>`. Use `prepend` to
      // insert material after the opening tag.
      //
      // This method is most often used when writing a module that adds new UI
      // to Apostrophe and allows you to add that markup without forcing
      // developers to customize their layout for your module to work.
      //
      // `conditions` argument can be an object with keys `when` and `bundler`
      // to specify when the component should be injected. `bundler` is the
      // alias of the currently registered asset external build module. For now
      // only `when: hmr` and `bundler: xxx` are supported.
      //
      // A new single argument signature is also supported, where the first and
      // only argument is an object.
      // See `insert()` for more details.
      // Usage:
      // apos.template.append({
      //   component: 'module-name:async-component-name',
      //   where: 'head',
      //   when: 'hmr', // or e.g. ['hmr', 'dev'], logical AND
      //   bundler: 'vite',
      // });
      // OR
      // apos.template.append('head', 'module-name:async-component-name',
      // { when: 'hmr', bundler: 'vite' });
      // Such call will match the following inject:
      // {% component '@apostrophecms/template:inject' with
      // { where: 'head', end: 'append', when: 'hmr' } %}
      // but only when the current asset bundler is 'vite'.

      append(location, componentName, conditions) {
        if (location && typeof location === 'object') {
          componentName = location.component;
        }
        if (typeof componentName !== 'string') {
          throw new Error('Do not pass a function to apos.template.prepend. Pass a fully qualified component name, i.e. module-name:async-component-name');
        }
        return self.insert('append', location, componentName, conditions);
      },

      // Implementation detail of `apos.template.prepend` and
      // `apos.template.append`. `conditions` is an object (optional) that may
      // have `when` and `bundler` keys. See below for more info. All conditions
      // are evaluated at a runtime, when the component is injected.
      //
      // If `location` is an object, the following arguments are ignored. The
      // object should have the following keys: - `component`: the component
      // name (e.g. 'module-name:component-name') - `where`: the location (e.g.
      // 'head') - `when`: (optional) string or array of strings, the conditions
      // to be met to insert the component. When an array, a logical AND is
      // applied. One match against the injected `when` data is required.
      // Currently supported values are `hmr`, `dev`, `prod`. See
      // `getInjectConditionHandlers()` for more info. The `when` value can
      // include an argument separated by `:`. E.g. `hmr:apos`, `hmr:public`. If
      // the condition handler does not support arguments, it's ignored. -
      // `bundler`: (optional) string, the alias of the currently registered
      // asset external build module. The bundler condition is not parth of the
      // actual inject data. It's evaluated just on the registration data.

      insert(end, location, componentName, conditions) {
        if (location && typeof location === 'object') {
          const {
            component, where, ...rest
          } = location;
          conditions = Object.keys(rest).length ? rest : null;
          componentName = component;
          location = where;
        }
        const key = end + '-' + location;
        self.insertions[key] = self.insertions[key] || [];
        self.insertions[key].push({
          component: componentName,
          conditions
        });
      },

      // Accepts the position and component key (e.g. `prepend-head`) and
      // returns an array of components that should be injected at that
      // position.
      getInjectedComponents(key, data) {
        const components = [];

        self.insertions[key]?.forEach(({ component, conditions = {} }) => {
          // BC
          if (!conditions.bundler && !conditions.when && !data.when) {
            components.push(component);
            return;
          }
          // Normalize in place
          if (!Array.isArray(conditions.when)) {
            conditions.when = conditions.when ? [ conditions.when ] : [];
          }
          // Both sides `when` should match
          if (data.when && !conditions.when.map(s => s.split(':')[0]).includes(data.when)) {
            return;
          }
          if (!data.when && conditions.when.length) {
            return;
          }

          // All `when` condition voters must agree.
          const { when, bundler } = conditions;
          const handlers = self.getInjectConditionHandlers();
          // Optional support for logical OR might be implemented,
          // just use `some`. A possible implementation with
          // `when` being an object same as the schema `if`, supporting
          // the same logical operators. But it's too much for now.
          const conditionMet = when.every(val => {
            const [ fn, arg ] = val.split(':');
            if (!handlers[fn]) {
              self.apos.util.error(`Invalid inject condition: ${when}`);
              return false;
            }
            return handlers[fn](arg, data);
          });

          if (bundler) {
            // Support for the internal webpack bundler
            const currentBundler = self.apos.asset.hasBuildModule()
              ? self.apos.asset.getBuildModuleAlias()
              : 'webpack';
            if (currentBundler !== bundler) {
              return;
            }
          }

          if (!conditionMet) {
            return;
          }

          components.push(component);
        });

        return components;
      },

      // Simple conditions handling for `when` injects. It can be extended to
      // support custom conditions in the future - registered by modules similar
      // to `helpers`. Every condition function receives an argument if
      // available and the nunjucks data object. For example `when: hmr:apos`
      // will call `hmr('apos', data)`. The function should return a boolean.
      getInjectConditionHandlers() {
        return {
          hmr(kind) {
            if (kind) {
              return self.apos.asset.hasHMR() &&
                self.apos.asset.getBuildOptions().devServer === kind;
            }
            return self.apos.asset.hasHMR();
          },
          dev() {
            return self.apos.asset.isDevMode();
          },
          prod() {
            return self.apos.asset.isProductionMode();
          }
        };
      },

      prependNodes(location, moduleName, method) {
        self.registerRuntimeNodes('prepend', location, moduleName, method);
      },

      appendNodes(location, moduleName, method) {
        self.registerRuntimeNodes('append', location, moduleName, method);
      },

      registerRuntimeNodes(end, location, moduleName, method) {
        if (typeof method !== 'string') {
          throw new Error(
            `Do not pass a function to "apos.template.${end}Nodes()". ` +
            'Pass a string with the name of the method to call on the module, ' +
            'e.g. "myMethod"'
          );
        }
        if (typeof moduleName !== 'string') {
          throw new Error(
            `Invalid "moduleName" detected in "apos.template.${end}Nodes()". ` +
            'Pass a string with the name of the module, e.g. "some-module"'
          );
        }

        if (typeof self.apos.modules[moduleName] === 'undefined') {
          throw new Error(
            `Invalid module "${moduleName}"detected in "apos.template.${end}Nodes()". ` +
            'Make sure the module is registered in your "app.js" file.'
          );
        }

        if (!self.apos.modules[moduleName][method]) {
          throw new Error(
            `Invalid method "${method}" detected in "apos.template.${end}Nodes()". ` +
            `Make sure the module "${moduleName}" has a method named "${method}".`
          );
        }

        const key = end + '-' + location;
        self.runtimeNodes[key] ||= [];
        self.runtimeNodes[key].push({
          moduleName,
          method
        });
      },

      // Accepts array of node objects and returns a string - HTML
      // representation of the nodes. Example nodes:
      // [
      //   {
      //     name: 'div',
      //     attrs: { class: 'my-class' },
      //     body: [
      //       {
      //         text: 'Hello world'
      //       }
      //     ]
      //   },
      //   {
      //     name: 'link',
      //     attrs: { href: '/some/path', rel: 'stylesheet' }
      //   }
      // ]
      // Node object SHOULD have either `name`, `text`, `raw` or `comment` property.
      // A node with `name` can have `attrs` (array of element attributes)
      // and `body` (array of child nodes, recursion).
      // `text` nodes are rendered as text (no HTML tags), the value is always a string.
      // `comment` nodes are rendered as HTML comments, the value is always a string.
      // `raw` nodes are rendered as is, no escaping, the value is always a string.
      renderNodes(nodes) {
        if (!Array.isArray(nodes)) {
          self.logError(
            'render-nodes',
            'Invalid nodes array passed to apos.template.renderNodes()'
          );
          return '';
        }
        return nodes.map(node => {
          if (node.text) {
            return self.apos.util.escapeHtml(node.text);
          }
          if (node.comment) {
            return `\n<!-- ${self.apos.util.escapeHtml(node.comment)} -->\n`;
          }
          if (node.raw) {
            return node.raw;
          }
          if (node.name) {
            const name = self.apos.util.escapeHtml(node.name);
            const attrs = Object.entries(node.attrs || {})
              .map(([ key, value ]) => {
                if (value === false || value === null || value === undefined) {
                  return '';
                }
                if (value === true) {
                  return ` ${self.apos.util.escapeHtml(key)}`;
                }
                return ` ${self.apos.util.escapeHtml(key)}="${self.apos.util.escapeHtml(value)}"`;
              })
              .join('')
              .trimEnd();

            if (!node.body && voidElements[name]) {
              return `<${name}${attrs} />`;
            }

            const body = (
              node.body ? self.renderNodes(node.body) : ''
            ).trim();

            return `<${name}${attrs}>${body}</${name}>`;
          }
          self.logError(
            'render-nodes',
            'Invalid node object passed to apos.template.renderNodes()',
            { node }
          );
          return '';
        })
          .join('')
          .trim();
      },

      injectNodes(req, locationKey) {
        const nodes = self.runtimeNodes[locationKey] || [];
        if (!nodes.length) {
          return '';
        }
        const output = [];
        for (const { moduleName, method } of nodes) {
          const handler = self.apos.modules[moduleName][method];
          output.push(self.renderNodes(handler(req)));
        }
        return output.join('\n');
      },

      async annotateDataForExternalFront(req, template, data, moduleName) {
        const docs = self.getDocsForExternalFront(req, template, data, moduleName);
        for (const doc of docs) {
          self.annotateDocForExternalFront(doc);
        }
        data.aposBodyData = await self.getBodyData(req);
        // Already contains module name too
        data.template = template;
        // For simple cases (not piece pages and the like)
        data.module = moduleName;

        // Provide the `apos` scene bundles to the exsternal front-end
        if (self.apos.asset.hasBuildModule()) {
          const modulePreload = new Set();
          data.bundleMarkup = {
            js: self.apos.asset.getBundlePageMarkup({
              scene: 'apos',
              output: 'js',
              modulePreload
            }),
            css: self.apos.asset.getBundlePageMarkup({
              scene: 'apos',
              output: 'css'
            })
          };
          data.bundleMarkup.js.push(...Array.from(modulePreload));
        }

        // `node` injections
        data.prependHead = self.injectNodes(req, 'prepend-head');
        data.appendHead = self.injectNodes(req, 'append-head');
        data.prependBody = self.injectNodes(req, 'prepend-body');
        data.appendBody = self.injectNodes(req, 'append-body');

        return data;
      },

      pruneDataForExternalFront(req, template, data, moduleName) {
        return data;
      },

      getDocsForExternalFront(req, template, data, moduleName) {
        return [
          data.home,
          ...(data.page?._ancestors || []),
          ...(data.page?._children || []),
          data.page,
          data.piece,
          ...(data.pieces || [])
        ].filter(doc => !!doc);
      },

      annotateDocForExternalFront(doc) {
        self.apos.doc.walk(doc, (o, k, v) => {
          if (v && v.metaType === 'area') {
            const manager = self.apos.util.getManagerOf(o);
            if (!manager) {
              self.apos.util.warnDevOnce('noManagerForDocInExternalFront', `No manager for: ${o.metaType} ${o.type || ''}`);
              return;
            }
            const field = manager.schema.find(f => f.name === k);
            if (!field) {
              self.apos.util.warnDevOnce(
                'noSchemaFieldForAreaInExternalFront',
                `Area ${k} has no matching schema field in ${o.metaType} ${o.type || ''}`
              );
              return;
            }
            return self.annotateAreaForExternalFront(field, v);
          }
        });
      },

      // Annotate an area for easy rendering by an external front end
      // such as Astro. This includes adding the `field`, `options`, `widgets`
      // and `choices` properties, and guaranteeing that `items` exists,
      // at least as an empty array.

      annotateAreaForExternalFront(field, area) {
        area.field = field;
        area.options = field.options;
        // Really widget configurations, but the method name is already set in
        // stone
        const widgets = self.apos.area.getWidgets(area.options);
        area.choices = Object.entries(widgets).map(([ name, options ]) => {
          const manager = self.apos.area.widgetManagers[name];
          return manager && {
            name,
            icon: manager.options.icon,
            label: options.addLabel || manager.label || `No label for ${name}`
          };
        }).filter(choice => !!choice);
        area.items ||= [];
        if (area._docId) {
          for (const item of area.items) {
            item._docId = area._docId;
          }
        }
      }
    };
  }
};
