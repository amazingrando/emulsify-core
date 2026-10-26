/**
 * @file Entries map builder for Vite/Rollup.
 *
 * Builds a keyed input map (for `build.rollupOptions.input`) where the map key
 * encodes the final folder inside the Vite outDir (default `dist/`).
 *
 * Modern projects:
 *   - Global/base assets -> "global/..."
 *   - Component assets   -> "components/..." (or mirrored to ./components when Drupal)
 *   - SDC=true removes the injected "/css" or "/js" bucket
 *
 * Style entries are `.scss` files, plus plain `.css` files when
 * project.emulsify.json sets `styles.cssEntries: true`.
 *
 * Component Structure Overrides projects (project.emulsify.json: variant.structureImplementations):
 *   - Only compile JS and style entries.
 *   - JS  -> "js/<relative-without-ext>"
 *   - CSS -> "css/<relative-without-ext>"
 *   - Twig/assets copying is handled by plugins using the same structure model.
 *   - cl-* / sb-* styles -> "storybook/<path-without-ext>"
 */

import fs from 'fs';
import { basename, relative, resolve } from 'path';
import {
  compiledAssetOutputPath,
  resolveProjectStructure,
  storybookStyleOutputPath,
} from './project-structure.js';
import { createSourceFileIndex } from './plugins/assets/source-file-index.js';
import { replaceLastSlash, toPosixPath } from './utils/paths.js';

export { replaceLastSlash, toPosixPath };

/** Remove characters that would confuse Rollup naming or file systems. */
export const sanitizePath = (s) => s.replace(/[^a-zA-Z0-9/_-]/g, '');

/**
 * @typedef {Object} BuildContext
 * @property {string} projectDir
 * @property {string} srcDir
 * @property {boolean} srcExists
 * @property {boolean} isDrupal - kept for downstream logic parity
 * @property {boolean} SDC
 * @property {boolean} structureOverrides
 * @property {string[]} [structureRoots]
 * @property {object} [sourceFileIndex]
 */

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Safe map setter that avoids prototype pollution keys.
 * @param {Record<string,string>} map
 * @param {string} key
 * @param {string} value
 */
function safeSetKey(map, key, value) {
  const forbidden = ['__proto__', 'prototype', 'constructor'];
  if (!key || forbidden.some((bad) => key.includes(bad))) return;
  map[key] = value;
}

/**
 * Normalize an entry key: POSIX separators, safe characters, no leading slash.
 * @param {string|null} key
 * @returns {string} Clean key, or an empty string when nothing usable remains.
 */
const cleanKey = (key) =>
  key ? sanitizePath(toPosixPath(key)).replace(/^\/+/, '') : '';

/** Determine whether a path is a plain `.css` source. */
const isCssSource = (filePath) => /\.css$/.test(filePath);

/** Return an absolute path from a source index entry or string. */
const entryPath = (entry) =>
  typeof entry === 'string' ? entry : entry.absPath;

/**
 * Determine whether a file should be compiled as a JS entry.
 *
 * Authoring-only siblings never become build entries: stories, documentation
 * modules, component metadata, pre-minified bundles, and tests.
 */
const isJavaScriptEntry = (entry) => {
  const filePath = entryPath(entry);
  return (
    /\.jsx?$/.test(filePath) &&
    !/\.(stories|docs?|component|min|test)\.jsx?$/.test(filePath)
  );
};

/**
 * Build a matcher for compiled stylesheet extensions.
 *
 * `.scss` always compiles. Plain `.css` compiles only when the project opts in
 * through `styles.cssEntries`; pre-minified `.min.css` stays a copied asset
 * either way.
 *
 * @param {boolean} cssEntries - Whether plain `.css` files are entries.
 * @returns {(name: string) => boolean} Stylesheet name matcher.
 */
const styleSourceMatcher = (cssEntries) => (name) =>
  /\.scss$/.test(name) ||
  (cssEntries && /\.css$/.test(name) && !/\.min\.css$/.test(name));

/**
 * Build the regular and Storybook style entry predicates for a project.
 *
 * Partials (`_name`) are import-only. `cl-`/`sb-` prefixed styles are
 * component-library styles emitted under the Storybook output path.
 *
 * @param {{cssEntries?: boolean}} structure - Resolved project structure.
 * @returns {{
 *   isStyleEntry: (entry: object|string) => boolean,
 *   isStorybookStyleEntry: (entry: object|string) => boolean
 * }} Style entry predicates.
 */
const createStyleEntryMatchers = (structure) => {
  const isStyleSource = styleSourceMatcher(structure.cssEntries === true);

  return {
    isStyleEntry: (entry) => {
      const name = basename(entryPath(entry));
      return (
        isStyleSource(name) &&
        !name.startsWith('_') &&
        !name.startsWith('cl-') &&
        !name.startsWith('sb-')
      );
    },
    isStorybookStyleEntry: (entry) => {
      const name = basename(entryPath(entry));
      return isStyleSource(name) && /(?:cl-|sb-)/.test(name);
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Inputs builder                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build the Rollup/Vite input map.
 *
 * Keys are paths **relative to outDir**, without extensions. Examples:
 *   - "global/layout/css/layout"
 *   - "components/accordion/js/accordion" (or without "/js" when SDC=true)
 *
 * For Component Structure Overrides (variant.structureImplementations present),
 * only JS/CSS keys are produced under "js/**" and "css/**".
 *
 * @param {BuildContext} ctx
 * @returns {Record<string, string>}
 */
export function buildInputs(ctx) {
  const structure = ctx.projectStructure || resolveProjectStructure(ctx);
  const sourceFileIndex =
    ctx.sourceFileIndex || createSourceFileIndex(structure);

  const { isStyleEntry, isStorybookStyleEntry } =
    createStyleEntryMatchers(structure);

  /** @type {Record<string, string>} */
  const inputs = {};

  /**
   * Style sources already claimed per entry key.
   * @type {Map<string, string>}
   */
  const styleKeys = new Map();

  /**
   * Add a key/file pair into the inputs map safely (sanitized + POSIX).
   * @param {string|null} key
   * @param {string} abs
   */
  const add = (key, abs) => {
    const clean = cleanKey(key);
    if (!clean) return;
    safeSetKey(inputs, clean, abs);
  };

  /**
   * Add a style entry, refusing to let `.css` and `.scss` share an output.
   *
   * `name.scss` and `name.css` beside each other resolve to the same output
   * key, so one would silently replace the other in `dist/`. Only pairs that
   * involve a `.css` source are rejected; that is reachable solely with
   * `styles.cssEntries` on, so SCSS-only projects keep their existing behavior.
   *
   * @param {string|null} key
   * @param {string} abs
   * @throws {Error} When a `.css` and another style source share a key.
   */
  const addStyle = (key, abs) => {
    const clean = cleanKey(key);
    if (!clean) return;
    const previous = styleKeys.get(clean);
    if (previous && previous !== abs && [previous, abs].some(isCssSource)) {
      const [first, second] = [previous, abs]
        .map((file) => toPosixPath(relative(ctx.projectDir || '', file)))
        .sort();
      throw new Error(
        `Emulsify style entries ${first} and ${second} both compile to "${clean}.css". Rename or remove one of them.`,
      );
    }
    styleKeys.set(clean, abs);
    add(clean, abs);
  };

  /* ------------------------------------------------------------------------ */
  /* STRUCTURE OVERRIDES BRANCH                                               */
  /* ------------------------------------------------------------------------ */
  if (structure.structureOverrides) {
    // Gather JS and styles from each declared variant root directory.
    const componentFiles = sourceFileIndex.componentFiles();
    const jsFiles = componentFiles.filter(isJavaScriptEntry);
    const styleFiles = componentFiles.filter(isStyleEntry);
    const storybookStyles = componentFiles.filter(isStorybookStyleEntry);

    // JS files emit under dist/js using the path below components when possible.
    for (const entry of jsFiles) {
      const file = entryPath(entry);
      add(compiledAssetOutputPath(file, 'js', structure, ctx), file);
    }

    // Style files emit under dist/css using the same relative path rules.
    for (const entry of styleFiles) {
      const file = entryPath(entry);
      addStyle(compiledAssetOutputPath(file, 'css', structure, ctx), file);
    }

    // Storybook and component-library styles stay under dist/storybook.
    for (const entry of storybookStyles) {
      const file = entryPath(entry);
      addStyle(storybookStyleOutputPath(file, structure, ctx), file);
    }

    return inputs;
  }

  /* ------------------------------------------------------------------------ */
  /* MODERN BRANCH (existing behavior preserved)                              */
  /* ------------------------------------------------------------------------ */
  const globalFiles = sourceFileIndex.globalFiles();
  const componentFiles = sourceFileIndex.componentFiles();

  // Global JS
  for (const entry of globalFiles.filter(isJavaScriptEntry)) {
    const file = entryPath(entry);
    add(compiledAssetOutputPath(file, 'js', structure, ctx), file);
  }

  // Component JS
  for (const entry of componentFiles.filter(isJavaScriptEntry)) {
    const file = entryPath(entry);
    add(compiledAssetOutputPath(file, 'js', structure, ctx), file);
  }

  // Global styles
  for (const entry of globalFiles.filter(isStyleEntry)) {
    const file = entryPath(entry);
    addStyle(compiledAssetOutputPath(file, 'css', structure, ctx), file);
  }

  // Component styles
  for (const entry of componentFiles.filter(isStyleEntry)) {
    const file = entryPath(entry);
    addStyle(compiledAssetOutputPath(file, 'css', structure, ctx), file);
  }

  // Storybook/CL styles
  for (const entry of sourceFileIndex.all().filter(isStorybookStyleEntry)) {
    const file = entryPath(entry);
    addStyle(storybookStyleOutputPath(file, structure, ctx), file);
  }

  return inputs;
}

/**
 * Convenience wrapper that infers `srcDir` and returns an inputs map.
 * @param {string} projectDir
 * @param {boolean} [isDrupal=false]
 * @param {boolean} [SDC=false]
 * @returns {Record<string,string>}
 */
export function buildInputsFromProject(
  projectDir,
  isDrupal = false,
  SDC = false,
) {
  const srcPath = resolve(projectDir, 'src');
  const srcExists = fs.existsSync(srcPath);
  const srcDir = srcExists ? srcPath : resolve(projectDir, 'components');

  const ctx = {
    projectDir,
    srcDir,
    srcExists,
    isDrupal,
    SDC,
    structureOverrides: false,
    structureRoots: [],
  };
  return buildInputs(ctx);
}
