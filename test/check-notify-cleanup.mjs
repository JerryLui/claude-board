// Criterion 21 (SPEC_STRANDED.md): "Exactly one code path in the product raises a
// notification. Searching the tree for the browser notification API returns nothing,
// in shipped code, in checks, and in the committed sample board."
//
// This is that search, run for real rather than asserted by name: a tree-wide grep for
// the browser Notification constructor and its permission dance, over src/, bin/,
// test/ and examples/. It is deliberately narrower than /\bNotification\b/, which
// would false-positive on every legitimate mention of macOS "Notification Center" and
// the UserNotifications framework scattered through src/notify.mjs, bin/notify.m and
// their own checks (test/check-notify.mjs, test/check-notify-click.mjs,
// test/check-launcher-env.mjs) -- none of that is the BROWSER api this criterion is
// about. Same reason the daemon's own `notifyRound` (src/notify.mjs, added by
// SPEC_STRANDED.md chunk 01, the surviving notifier per ADR.md entry 58) must sail
// through untouched: these patterns match the browser constructor and its
// permission surface by punctuation, never the identifier `notifyRound` by name.
//
// "It must not find itself" (SPEC_STRANDED.md ticket 06): this file's own path is
// excluded from the walk, since a grep for these patterns necessarily contains them
// as string/regex literals to define the search.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const selfPath = fileURLToPath(import.meta.url);

// The browser notification API, precisely: the constructor and the three
// permission-dance surfaces src/ui.mjs's deleted notifyRound and
// requestNotifyPermissionFromSend used to touch (ADR.md entry 58).
const BROWSER_NOTIFICATION_API = [
  [/\bnew\s+Notification\s*\(/, 'the Notification constructor'],
  [/\bNotification\.requestPermission\b/, 'Notification.requestPermission'],
  [/\bNotification\.permission\b/, 'Notification.permission'],
  [/\btypeof\s+Notification\b/, 'a typeof Notification guard'],
  [/\bwindow\.Notification\b/, 'window.Notification'],
];

const SCAN_DIRS = ['src', 'bin', 'test', 'examples'];
const SCAN_EXT = /\.(mjs|js|html)$/;

function walk(dir, ext = SCAN_EXT, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, ext, out);
    else if (ext.test(entry) && full !== selfPath) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap(d => walk(path.join(repoRoot, d)));
const MD_EXT = /\.md$/;

check('setup sanity: the walk actually finds files to search, in every scanned directory', () => {
  assert.ok(files.length > 50, `expected a substantial file list, got ${files.length}`);
  for (const d of SCAN_DIRS) {
    assert.ok(files.some(f => f.startsWith(path.join(repoRoot, d) + path.sep)), `no file found under ${d}/`);
  }
});

check('setup sanity: the patterns actually match browser Notification API syntax when present', () => {
  const sample = "if (typeof Notification === 'undefined') return; var n = new Notification('x'); Notification.requestPermission(); Notification.permission; window.Notification;";
  for (const [re] of BROWSER_NOTIFICATION_API) assert.match(sample, re, `pattern ${re} failed to match its own target syntax`);
});

check('setup sanity: this check does not find itself', () => {
  assert.ok(!files.includes(selfPath), 'the walk must exclude its own file');
});

check('setup sanity: the daemon\'s own notifyRound (src/notify.mjs) is untouched by this grep', () => {
  const notifyMjs = readFileSync(path.join(repoRoot, 'src/notify.mjs'), 'utf8');
  assert.match(notifyMjs, /export function notifyRound/, 'setup failure: src/notify.mjs no longer exports notifyRound -- has it moved?');
  for (const [re, label] of BROWSER_NOTIFICATION_API) {
    assert.ok(!re.test(notifyMjs), `the daemon's own notifyRound must not trip the browser-API grep (matched ${label})`);
  }
});

check('criterion 21: the browser notification API appears nowhere in shipped code, checks, or the committed sample board', () => {
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [re, label] of BROWSER_NOTIFICATION_API) {
      if (re.test(text)) hits.push(`${path.relative(repoRoot, file)}: ${label}`);
    }
  }
  assert.deepEqual(hits, [], `the browser notification API must appear nowhere in the tree:\n${hits.join('\n')}`);
});

// Criterion 25 (SPEC_STRANDED.md): "No document describes a browser notification, its
// permission grant, or a tab that reopens itself as current behaviour." The decision
// record is explicitly exempt -- it is the record of why they went, so it is SUPPOSED to
// still name them. Its entries live in `.agents/adr/`, which nothing below walks, and its
// index `ADR.md` is excluded from DOC_FILES rather than merely left unwalked, so a rename
// of this list can never silently start scanning either.
//
// This is deliberately narrower than a prose sweep for words like "notification" or
// "permission" on their own: both remain completely legitimate throughout these docs for
// the surviving daemon banner and the bundle's own macOS notification grant (README.md
// "allowing notifications", QUIRKS.md's bundle-identity notes, SECURITY.md's cookie-write
// list). A phrase-level heuristic trying to catch prose *about* the deleted behaviour
// without naming any dead symbol was tried while writing this check and produced a false
// positive on QUIRKS.md's own corrected paragraph -- "there is no longer a per-origin or
// per-browser-profile grant to chase" -- because it matched on nearby words while blind to
// the negation. Anything that fragile is worse than not checking: it teaches a maintainer
// to distrust the check rather than the prose. So this stays at the same altitude as
// criterion 21's code grep, matching only the dead API surface and the three symbol names
// a doc could only contain by quoting the deleted code (`requestNotifyPermissionFromSend`,
// `reopenIfNoClient`, `connectedClientCount`) -- unambiguous either way, never triggered by
// prose correctly describing their absence. The prose itself was swept by hand
// (SPEC_STRANDED.md ticket 08) and is not re-verified mechanically here.
const DEAD_DOC_MARKERS = [
  ...BROWSER_NOTIFICATION_API,
  [/\brequestNotifyPermissionFromSend\b/, 'requestNotifyPermissionFromSend (deleted, src/ui.mjs)'],
  [/\breopenIfNoClient\b/, 'reopenIfNoClient (deleted, bin/mcp.mjs)'],
  [/\bconnectedClientCount\b/, 'connectedClientCount (deleted, bin/mcp.mjs)'],
];

const DOC_FILES = ['README.md', 'INSTALL.md', 'SECURITY.md', 'PROTOCOL.md', 'QUIRKS.md', 'CHANGELOG.md']
  .map(f => path.join(repoRoot, f))
  .concat(walk(path.join(repoRoot, 'skills'), MD_EXT))
  .filter(f => existsSync(f));

check('setup sanity: DOC_FILES resolves a real, non-trivial set of tracked documents, ADR.md excluded', () => {
  assert.ok(DOC_FILES.length >= 5, `expected several doc files, got ${DOC_FILES.length}`);
  assert.ok(DOC_FILES.some(f => f.endsWith('README.md')));
  assert.ok(DOC_FILES.some(f => f.endsWith('PROTOCOL.md')));
  assert.ok(!DOC_FILES.some(f => f.endsWith(`${path.sep}ADR.md`)), 'ADR.md must be excluded -- it is exempt, being the record of why the deleted behaviour went');
});

check('criterion 25: no tracked document names the deleted browser notification API or the symbols the deletion removed', () => {
  const hits = [];
  for (const file of DOC_FILES) {
    const text = readFileSync(file, 'utf8');
    for (const [re, label] of DEAD_DOC_MARKERS) {
      if (re.test(text)) hits.push(`${path.relative(repoRoot, file)}: ${label}`);
    }
  }
  assert.deepEqual(hits, [], `no document should reference the deleted browser notification API or its symbols:\n${hits.join('\n')}`);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall notify-cleanup checks ok');
