import commonjs from '@rollup/plugin-commonjs';
import { stringMatchesSomePattern } from '@sentry/utils';
import * as fs from 'fs';
import * as path from 'path';
import { rollup } from 'rollup';

import type { LoaderThis } from './types';

const apiWrapperTemplatePath = path.resolve(__dirname, '..', 'templates', 'apiWrapperTemplate.js');
const apiWrapperTemplateCode = fs.readFileSync(apiWrapperTemplatePath, { encoding: 'utf8' });

const pageWrapperTemplatePath = path.resolve(__dirname, '..', 'templates', 'pageWrapperTemplate.js');
const pageWrapperTemplateCode = fs.readFileSync(pageWrapperTemplatePath, { encoding: 'utf8' });

const middlewareWrapperTemplatePath = path.resolve(__dirname, '..', 'templates', 'middlewareWrapperTemplate.js');
const middlewareWrapperTemplateCode = fs.readFileSync(middlewareWrapperTemplatePath, { encoding: 'utf8' });

// Just a simple placeholder to make referencing module consistent
const SENTRY_WRAPPER_MODULE_NAME = 'sentry-wrapper-module';

// Needs to end in .cjs in order for the `commonjs` plugin to pick it up
const WRAPPING_TARGET_MODULE_NAME = '__SENTRY_WRAPPING_TARGET_FILE__.cjs';

type LoaderOptions = {
  pagesDir: string;
  pageExtensionRegex: string;
  excludeServerRoutes: Array<RegExp | string>;
};

/**
 * Replace the loaded file with a wrapped version the original file. In the wrapped version, the original file is loaded,
 * any data-fetching functions (`getInitialProps`, `getStaticProps`, and `getServerSideProps`) or API routes it contains
 * are wrapped, and then everything is re-exported.
 */
export default function wrappingLoader(
  this: LoaderThis<LoaderOptions>,
  userCode: string,
  userModuleSourceMap: any,
): void | string {
  // We know one or the other will be defined, depending on the version of webpack being used
  const {
    pagesDir,
    pageExtensionRegex,
    excludeServerRoutes = [],
  } = 'getOptions' in this ? this.getOptions() : this.query;

  this.async();

  // Get the parameterized route name from this page's filepath
  const parameterizedRoute = path
    // Get the path of the file insde of the pages directory
    .relative(pagesDir, this.resourcePath)
    // Add a slash at the beginning
    .replace(/(.*)/, '/$1')
    // Pull off the file extension
    .replace(new RegExp(`\\.(${pageExtensionRegex})`), '')
    // Any page file named `index` corresponds to root of the directory its in, URL-wise, so turn `/xyz/index` into
    // just `/xyz`
    .replace(/\/index$/, '')
    // In case all of the above have left us with an empty string (which will happen if we're dealing with the
    // homepage), sub back in the root route
    .replace(/^$/, '/');

  // Skip explicitly-ignored pages
  if (stringMatchesSomePattern(parameterizedRoute, excludeServerRoutes, true)) {
    this.callback(null, userCode, userModuleSourceMap);
    return;
  }

  const middlewareJsPath = path.join(pagesDir, '..', 'middleware.js');
  const middlewareTsPath = path.join(pagesDir, '..', 'middleware.ts');

  let templateCode: string;
  if (parameterizedRoute.startsWith('/api')) {
    templateCode = apiWrapperTemplateCode;
  } else if (this.resourcePath === middlewareJsPath || this.resourcePath === middlewareTsPath) {
    templateCode = middlewareWrapperTemplateCode;
  } else {
    templateCode = pageWrapperTemplateCode;
  }

  // Inject the route and the path to the file we're wrapping into the template
  templateCode = templateCode.replace(/__ROUTE__/g, parameterizedRoute.replace(/\\/g, '\\\\'));

  // Replace the import path of the wrapping target in the template with a path that the `wrapUserCode` function will understand.
  templateCode = templateCode.replace(/__SENTRY_WRAPPING_TARGET_FILE__/g, WRAPPING_TARGET_MODULE_NAME);

  // Run the proxy module code through Rollup, in order to split the `export * from '<wrapped file>'` out into
  // individual exports (which nextjs seems to require).
  wrapUserCode(templateCode, userCode, userModuleSourceMap)
    .then(({ code: wrappedCode, map: wrappedCodeSourceMap }) => {
      this.callback(null, wrappedCode, wrappedCodeSourceMap);
    })
    .catch(err => {
      // eslint-disable-next-line no-console
      console.warn(
        `[@sentry/nextjs] Could not instrument ${this.resourcePath}. An error occurred while auto-wrapping:\n${err}`,
      );
      this.callback(null, userCode, userModuleSourceMap);
      return;
    });
}

/**
 * Use Rollup to process the proxy module code, in order to split its `export * from '<wrapped file>'` call into
 * individual exports (which nextjs seems to need).
 *
 * Wraps provided user code (located under the import defined via WRAPPING_TARGET_MODULE_NAME) with provided wrapper
 * code. Under the hood, this function uses rollup to bundle the modules together. Rollup is convenient for us because
 * it turns `export * from '<wrapped file>'` (which Next.js doesn't allow) into individual named exports.
 *
 * Note: This function may throw in case something goes wrong while bundling.
 *
 * @param wrapperCode The wrapper module code
 * @param userModuleCode The user module code
 * @returns The wrapped user code and a source map that describes the transformations done by this function
 */
async function wrapUserCode(
  wrapperCode: string,
  userModuleCode: string,
  userModuleSourceMap: any,
): Promise<{ code: string; map?: any }> {
  const rollupBuild = await rollup({
    input: SENTRY_WRAPPER_MODULE_NAME,

    plugins: [
      // We're using a simple custom plugin that virtualizes our wrapper module and the user module, so we don't have to
      // mess around with file paths and so that we can pass the original user module source map to rollup so that
      // rollup gives us a bundle with correct source mapping to the original file
      {
        name: 'virtualize-sentry-wrapper-modules',
        resolveId: id => {
          if (id === SENTRY_WRAPPER_MODULE_NAME || id === WRAPPING_TARGET_MODULE_NAME) {
            return id;
          } else {
            return null;
          }
        },
        load(id) {
          if (id === SENTRY_WRAPPER_MODULE_NAME) {
            return wrapperCode;
          } else if (id === WRAPPING_TARGET_MODULE_NAME) {
            return {
              code: userModuleCode,
              map: userModuleSourceMap, // give rollup acces to original user module source map
            };
          } else {
            return null;
          }
        },
      },

      // People may use `module.exports` in their API routes or page files. Next.js allows that and we also need to
      // handle that correctly so we let a plugin to take care of bundling cjs exports for us.
      commonjs({
        transformMixedEsModules: true,
        sourceMap: true,
      }),
    ],

    // We only want to bundle our wrapper module and the wrappee module into one, so we mark everything else as external.
    external: sourceId => sourceId !== SENTRY_WRAPPER_MODULE_NAME && sourceId !== WRAPPING_TARGET_MODULE_NAME,

    // Prevent rollup from stressing out about TS's use of global `this` when polyfilling await. (TS will polyfill if the
    // user's tsconfig `target` is set to anything before `es2017`. See https://stackoverflow.com/a/72822340 and
    // https://stackoverflow.com/a/60347490.)
    context: 'this',

    // Rollup's path-resolution logic when handling re-exports can go wrong when wrapping pages which aren't at the root
    // level of the `pages` directory. This may be a bug, as it doesn't match the behavior described in the docs, but what
    // seems to happen is this:
    //
    //   - We try to wrap `pages/xyz/userPage.js`, which contains `export { helperFunc } from '../../utils/helper'`
    //   - Rollup converts '../../utils/helper' into an absolute path
    //   - We mark the helper module as external
    //   - Rollup then converts it back to a relative path, but relative to `pages/` rather than `pages/xyz/`. (This is
    //     the part which doesn't match the docs. They say that Rollup will use the common ancestor of all modules in the
    //     bundle as the basis for the relative path calculation, but both our temporary file and the page being wrapped
    //     live in `pages/xyz/`, and they're the only two files in the bundle, so `pages/xyz/`` should be used as the
    //     root. Unclear why it's not.)
    //   - As a result of the miscalculation, our proxy module will include `export { helperFunc } from '../utils/helper'`
    //     rather than the expected `export { helperFunc } from '../../utils/helper'`, thereby causing a build error in
    //     nextjs..
    //
    // Setting `makeAbsoluteExternalsRelative` to `false` prevents all of the above by causing Rollup to ignore imports of
    // externals entirely, with the result that their paths remain untouched (which is what we want).
    makeAbsoluteExternalsRelative: false,

    onwarn: (_warning, _warn) => {
      // Suppress all warnings - we don't want to bother people with this output
      // Might be stuff like "you have unused imports"
      // _warn(_warning); // uncomment to debug
    },
  });

  const finalBundle = await rollupBuild.generate({
    format: 'esm',
    sourcemap: 'hidden', // put source map data in the bundle but don't generate a source map commment in the output
  });

  // The module at index 0 is always the entrypoint, which in this case is the proxy module.
  return finalBundle.output[0];
}
