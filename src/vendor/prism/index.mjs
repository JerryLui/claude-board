// A hand-written loader over vendored, byte-for-byte prismjs 1.30.0 source -- this
// file is the only non-upstream code under src/vendor/prism/, and it exists because
// prismjs does not ship an ESM build (ADR 62 says "self-contained ESM"; here is
// exactly where that needed care).
//
// What prismjs actually ships: `prism-core.js` and one file per grammar
// (`prism-<lang>.js`), each written for a `<script>` tag or a bundler's CommonJS
// `require()` -- never `import`/`export`. Core ends by doing
// `module.exports = Prism` when a CJS `module` exists, and UNCONDITIONALLY also does
// `global.Prism = Prism`. Every grammar file then references a bare, undeclared
// `Prism` identifier (e.g. `Prism.languages.python = ...`, or
// `(function (Prism) { ... }(Prism))`), which only resolves because core planted it
// on the real global object first -- that is how prismjs has always expected to be
// loaded outside a bundler (script tags share one global `window.Prism`; Node
// CommonJS shares one process `global.Prism`), and it is why the grammar files
// require no changes at all to work here.
//
// This repo's root package.json sets `"type": "module"`, so a plain `.js` file
// anywhere under src/ is parsed as an ES module -- and `var Prism = (function ...`
// followed by a bare `module.exports = Prism` is not valid top-level ESM (`module`
// is simply undefined there, silently, because of the `typeof module !== 'undefined'`
// guard -- so nothing throws, but nothing exports either, and the grammar files
// never get a `Prism` global to attach to). The vendored files were therefore copied
// in VERBATIM -- not one byte of prismjs's own source changed, which is what the
// sha256 manifest in src/vendor/manifest.json guards -- and given the `.cjs`
// extension instead of `.js`. `.cjs` is one of the two extensions (with `.mjs`) whose
// module type Node decides from the extension alone, ignoring `"type"` in the
// nearest package.json entirely, so these files run as CommonJS here regardless of
// the rest of the repo. That is the ONLY liberty taken with upstream's layout.
//
// Loaded in dependency order (each grammar that `require`s another one, per
// prismjs's own components.json, listed after what it needs): markup and clike are
// bases with no dependency of their own; javascript needs clike; typescript needs
// javascript; jsx needs markup + javascript; tsx needs jsx + typescript; cpp needs c;
// c/ruby/go/java/kotlin need clike; markdown needs markup. Getting this order wrong
// throws immediately (e.g. `Prism.languages.extend('clike', ...)` reading
// `Prism.languages.clike` before it exists) -- there is no lazy/topological loader
// here on purpose, because the whole set is ~70KB of definitions and loading all of
// it eagerly, once, at import time is simpler than one and costs nothing measurable.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// eslint-disable-next-line import/no-commonjs -- see header: this IS prismjs's own
// module-detection branch, unmodified, just reached via CJS interop instead of a
// browser <script> tag.
const Prism = require('./prism-core.cjs');

const GRAMMAR_LOAD_ORDER = [
  'markup', 'clike',
  'javascript', 'typescript', 'jsx', 'tsx',
  'python', 'ruby', 'go', 'rust', 'java',
  'c', 'cpp',
  'bash', 'json', 'yaml', 'markdown',
  'css', 'sql', 'swift', 'kotlin',
  'diff',
];

for (const name of GRAMMAR_LOAD_ORDER) {
  // Side-effecting require: each file mutates the same `Prism.languages` object
  // this module already holds a reference to (via the shared global -- see header).
  require(`./components/prism-${name}.cjs`);
}

// prismjs's own build tool would normally generate this assignment from
// components.json's `"alias": "html"` entry on the `markup` grammar; we are not
// running that tool, so it is written out by hand, once, here. Every OTHER name
// `langForPath` (src/resolve.mjs) produces is already a grammar's own primary key
// after the requires above (javascript, typescript, tsx, jsx, python, ruby, go,
// rust, java, c, cpp, bash, json, yaml, markdown, css, sql, swift, kotlin, diff) --
// `html` is the one exception, aliased to identical markup.
Prism.languages.html = Prism.languages.markup;

// The names `langForPath` (src/resolve.mjs) can produce, plus `diff` (needed by
// a referenced `.patch`/`.diff` file or a fenced `diff` block) -- the fixed set
// this vendoring drop is required to cover. Exported so a check can assert every
// one of these actually resolves to a loaded grammar, offline, without hand-copying
// this list a second time.
export const SUPPORTED_LANGUAGES = Object.freeze([
  'javascript', 'typescript', 'tsx', 'jsx', 'python', 'ruby', 'go', 'rust',
  'java', 'c', 'cpp', 'bash', 'json', 'yaml', 'markdown', 'html', 'css', 'sql',
  'swift', 'kotlin', 'diff',
]);

/** Look up a grammar by the language name `langForPath` produces (or `'diff'`).
 * Returns `undefined` for anything not vendored -- callers fall back to plain
 * escaped text, never throw, exactly like today's behaviour for a lang
 * with no highlighting support. */
export function grammarFor(lang) {
  return Object.prototype.hasOwnProperty.call(Prism.languages, lang)
    ? Prism.languages[lang]
    : undefined;
}

export { Prism };
