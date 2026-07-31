// Extract the board's stylesheet from src/styles.mjs into a real .css file for
// design-sync. The CSS lives in the repo as a template string (render.mjs inlines
// it so the page stays one self-contained file), so there is no .css on disk for
// the converter's cssEntry to point at -- this writes one from the module's own
// export. Not a transform: the bytes are exactly what the board serves.
//
// Re-run before every sync; the output is gitignored build product.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const { styles, palettes } = await import(resolve(repo, 'src/styles.mjs'));

const outDir = resolve(here, 'css');
mkdirSync(outDir, { recursive: true });

// The full sheet: token blocks (dark :root, light under prefers-color-scheme and
// [data-theme="light"]) followed by every component rule.
writeFileSync(resolve(outDir, 'claude-board.css'), styles.trimStart() + '\n');

// Tokens alone, for the converter's tokens/ dir. Same values, no component rules,
// so a consumer can take the palette without the board's markup vocabulary.
const tokenBlock = (selector, palette, scheme) =>
  `${selector} {\n  color-scheme: ${scheme};\n` +
  Object.entries(palette).map(([n, v]) => `  ${n}: ${v};`).join('\n') +
  '\n}\n';

// Non-color tokens are shared between palettes and declared in styles.mjs's own
// second :root block -- lift them verbatim rather than restating the values here,
// so radii/spacing/motion can never drift from the source.
const sharedRoot = styles.match(/:root \{\n  \/\* non-color tokens[\s\S]*?\n\}/);
if (!sharedRoot) {
  console.error('! shared :root block not found in styles.mjs -- token file will omit radii/spacing/motion');
}

writeFileSync(
  resolve(outDir, 'tokens.css'),
  '/* claude-board design tokens, extracted from src/styles.mjs */\n\n' +
    tokenBlock(':root', palettes.dark, 'dark') +
    '\n@media (prefers-color-scheme: light) {\n' +
    tokenBlock(':root:not([data-theme="dark"])', palettes.light, 'light') +
    '}\n\n' +
    tokenBlock(':root[data-theme="light"]', palettes.light, 'light') +
    (sharedRoot ? '\n' + sharedRoot[0] + '\n' : ''),
);

const count = (s, rx) => new Set(s.match(rx) || []).size;
console.log(`css: ${styles.length} bytes, ${count(styles, /--[a-z0-9-]+(?=\s*:)/g)} tokens, ${count(styles, /\.[a-z][a-z0-9_-]*/gi)} classes`);
