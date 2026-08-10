// ADR.md entry 62: every file under src/vendor/ matches a recorded sha256, asserted with NO network --
// patterned on install.sh's `payload_digest` (install.sh:467) and
// test/check-install-payload.mjs's proof of it, but per-file rather than one folded
// digest, because AC 15 asks "each file... matches a recorded sha256", not "the tree
// matches one hash". A folded digest can only say THAT something drifted; a per-file
// manifest says WHICH vendored file drifted, which is the more useful failure for a
// pinned third-party drop nobody here maintains day to day.
//
// The manifest lives at test/fixtures/vendor-manifest.json -- NOT under src/vendor/
// itself. A manifest recording src/vendor/'s own digests cannot also live inside the
// tree it describes without a fixed-point problem (the manifest's own bytes would
// have to hash themselves). "Next to the check" (the alternative this ticket's brief
// names) sidesteps that for free.
//
// Three ways to fail, all required by AC 15's own wording: a vendored byte changes
// (digest mismatch), a file is added (present on disk, absent from the manifest), or
// a file goes missing (present in the manifest, absent on disk) -- asserted together
// as one set-equality check plus a per-file digest loop, so any of the three names
// itself rather than surfacing as a generic "manifest doesn't match" failure.
//
// Beyond the digest, this file also proves the OTHER half of ticket 01's brief that a
// hash can't: "the imports must be usable" for the chunks that come after. A grammar
// file sitting on disk with the right sha256 is not evidence it actually loads under
// Node's ESM resolver or that Prism can tokenize with it -- see src/vendor/prism/index.mjs's
// own header for why prismjs's CJS-shaped source needed the `.cjs` extension trick to
// load at all here. So: import the real vendored marked and the real vendored Prism
// loader, parse something with marked, and tokenize a real sample in every one of the
// 19 languages `langForPath` (src/resolve.mjs) names plus `diff` (vendored ahead of
// need, for chunk 05) -- cross-checked against `langForPath` itself, not a hand-copied
// list, so a future edit to resolve.mjs's extension table cannot drift silently past
// this check.
//
// NOTE on "19": AC 2's prose says "All 19 languages... have a vendored grammar" but
// its own comma-separated list enumerates TWENTY names (javascript through kotlin,
// including html) -- an off-by-one between the prose and the list it's attached to.
// This check follows the ENUMERATED list (the concrete, checkable artifact) rather
// than the prose count, and vendors + proves all 20 named languages tokenize. Worth
// reconciling in the spec; flagged in ticket 01's closing report rather than silently
// picking one number.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(selfPath), '..');
const vendorRoot = path.join(repoRoot, 'src', 'vendor');
// Overridable ONLY so this check can prove its own gate: the "tampering stops the
// run" check below re-runs this file in a child process against a deliberately wrong
// manifest, and a digest guard that cannot be observed failing is a guard nobody has
// tested. The override also marks the child, which is how the gate check skips itself
// there instead of spawning grandchildren forever.
const REAL_MANIFEST = path.join(repoRoot, 'test', 'fixtures', 'vendor-manifest.json');
const manifestPath = process.env.CLAUDE_BOARD_VENDOR_MANIFEST || REAL_MANIFEST;

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
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestFiles = Object.keys(manifest).sort();
  const actualFiles = walk(vendorRoot)
    .map(f => path.relative(vendorRoot, f).split(path.sep).join('/'))
    .sort();

  check('the vendored file set on disk exactly matches the manifest -- no added, no missing', () => {
    assert.deepEqual(actualFiles, manifestFiles,
      `disk vs manifest mismatch.\nonly on disk: ${JSON.stringify(actualFiles.filter(f => !manifestFiles.includes(f)))}\nonly in manifest: ${JSON.stringify(manifestFiles.filter(f => !actualFiles.includes(f)))}`);
  });

  for (const rel of manifestFiles) {
    check(`sha256 matches the recorded digest: src/vendor/${rel}`, () => {
      const full = path.join(vendorRoot, rel);
      const actual = sha256(readFileSync(full));
      assert.equal(actual, manifest[rel], `src/vendor/${rel} has drifted from its recorded sha256 -- if this is an intentional version bump, re-record the manifest, don't just silence the check`);
    });
  }

  // --- the digest is a GATE, not a report ----------------------------------------
  //
  // Everything below this point `await import(...)`s the vendored tree, which
  // `require`s all 27 vendored files. If a drifted file could reach that, this check
  // would print FAIL for tampered bytes and then EXECUTE them -- the one thing a
  // tamper guard must not do. Proven by running this same file in a child against a
  // manifest with one wrong digest and asserting the vendored imports never happen.
  if (!process.env.CLAUDE_BOARD_VENDOR_MANIFEST) {
    check('a drifted digest stops the run BEFORE anything imports the vendored tree', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'vendor-gate-'));
      try {
        const tampered = { ...manifest, [manifestFiles[0]]: 'f'.repeat(64) };
        const tamperedPath = path.join(tmp, 'vendor-manifest.json');
        writeFileSync(tamperedPath, JSON.stringify(tampered), 'utf8');
        const run = spawnSync(process.execPath, [selfPath], {
          encoding: 'utf8',
          env: { ...process.env, CLAUDE_BOARD_VENDOR_MANIFEST: tamperedPath },
        });
        const out = `${run.stdout || ''}${run.stderr || ''}`;
        assert.equal(run.status, 1, `a drifted digest must exit non-zero, got ${run.status}`);
        assert.match(out, /has drifted from its recorded sha256/);
        assert.ok(!out.includes('imports and parses GFM'),
          `the vendored tree was imported anyway after a digest failure:\n${out}`);
        assert.ok(!out.includes('tokenizes a real sample'),
          `the vendored Prism loader ran anyway after a digest failure:\n${out}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed -- refusing to import the vendored tree`);
    process.exit(1);
  }

  // --- the imports later chunks will use actually work, offline ------------------------

  await checkAsync('vendored marked (src/vendor/marked/marked.esm.js) imports and parses GFM', async () => {
    const { marked } = await import('../src/vendor/marked/marked.esm.js');
    const html = marked.parse('# Title\n\n- [x] done\n\n[ref][r]\n\n[r]: https://example.com "t"');
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /type="checkbox"/); // GFM task list
    assert.match(html, /href="https:\/\/example.com"/); // reference-style link resolves
  });

  await checkAsync('vendored Prism (src/vendor/prism/index.mjs) tokenizes a real sample in every langForPath language plus diff', async () => {
    const { langForPath } = await import('../src/resolve.mjs');
    const { grammarFor, Prism, SUPPORTED_LANGUAGES } = await import('../src/vendor/prism/index.mjs');

    // The 19 extension -> language pairs src/resolve.mjs's EXT_LANG actually maps,
    // read through the real langForPath function rather than a hand-copied list --
    // if resolve.mjs's table ever adds or renames a language, this drifts and fails
    // here instead of silently leaving a language unhighlighted.
    const EXT_SAMPLES = {
      js: ['javascript', 'const x = 1; // c'],
      ts: ['typescript', 'const x: number = 1;'],
      tsx: ['tsx', 'const x = <div a={1}/>;'],
      jsx: ['jsx', 'const x = <div/>;'],
      py: ['python', 'def f(x):\n    return x + 1'],
      rb: ['ruby', 'def f(x)\n  x + 1\nend'],
      go: ['go', 'func main() { fmt.Println(1) }'],
      rs: ['rust', 'fn main() { println!("hi"); }'],
      java: ['java', 'class A { void f() {} }'],
      c: ['c', 'int main() { return 0; }'],
      cpp: ['cpp', 'int main() { return 0; }'],
      sh: ['bash', 'echo "hi" # comment'],
      json: ['json', '{"a": 1}'],
      yaml: ['yaml', 'a: 1\nb: [1, 2]'],
      md: ['markdown', '# Title\n\ntext'],
      html: ['html', '<div class="a">hi</div>'],
      css: ['css', '.a { color: red; }'],
      sql: ['sql', 'SELECT * FROM t WHERE a = 1;'],
      swift: ['swift', 'func f() -> Int { return 1 }'],
      kt: ['kotlin', 'fun f(): Int { return 1 }'],
    };
    assert.equal(Object.keys(EXT_SAMPLES).length, 20, 'sanity: this check must cover all 20 extensions resolve.mjs maps (some languages share one, e.g. .kt/.kts both -> kotlin)');

    const seenLangs = new Set();
    for (const [ext, [expectedLang, sample]] of Object.entries(EXT_SAMPLES)) {
      const actualLang = langForPath(`x.${ext}`);
      assert.equal(actualLang, expectedLang, `langForPath('x.${ext}') must still resolve to '${expectedLang}'`);
      seenLangs.add(actualLang);

      const grammar = grammarFor(actualLang);
      assert.ok(grammar, `grammarFor('${actualLang}') must return a loaded Prism grammar (langForPath names it, so it must be vendored -- AC 2)`);

      const tokens = Prism.tokenize(sample, grammar);
      const matchedSomething = tokens.some(t => typeof t !== 'string');
      assert.ok(matchedSomething, `tokenizing a real ${actualLang} sample must produce at least one real token, not just unmatched text -- an empty/broken grammar would still return a 1-element array of the input string unchanged`);
    }

    // langForPath names exactly 20 distinct languages (AC 2's own enumerated list --
    // see the "NOTE on 19" above); confirm the extension table above actually
    // exercised all of them, not fewer by accident.
    assert.equal(seenLangs.size, 20, `expected exactly 20 distinct languages out of langForPath (AC 2's enumerated list), saw: ${[...seenLangs].sort().join(', ')}`);
    for (const lang of ['javascript', 'typescript', 'tsx', 'jsx', 'python', 'ruby', 'go', 'rust', 'java', 'c', 'cpp', 'bash', 'json', 'yaml', 'markdown', 'html', 'css', 'sql', 'swift', 'kotlin']) {
      assert.ok(seenLangs.has(lang), `AC 2 names '${lang}' as one of langForPath's languages; it must have been exercised above`);
    }

    // diff is vendored ahead of need (chunk 05: a referenced .patch/.diff or a fenced
    // diff block) -- langForPath does not name it yet (that wiring is chunk 05's, per
    // AC 3), so it is proven directly against the grammar registry instead.
    const diffGrammar = grammarFor('diff');
    assert.ok(diffGrammar, "grammarFor('diff') must return a loaded Prism grammar");
    const diffTokens = Prism.tokenize('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new', diffGrammar);
    assert.ok(diffTokens.some(t => typeof t !== 'string'), 'tokenizing a real diff sample must produce at least one real token');

    assert.deepEqual([...SUPPORTED_LANGUAGES].sort(), [...seenLangs, 'diff'].sort(),
      'SUPPORTED_LANGUAGES must be exactly the langForPath languages (AC 2\'s enumerated list) plus diff -- no more, no less');
  });
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall vendor-digest checks ok');
  });
