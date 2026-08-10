// Comment/code drift check for src/, bin/ and test/, following test/check-skill-prose.mjs's
// shape: prose bound to the code it describes, so a claim that stops being true fails the
// suite on the commit that broke it rather than misleading whoever trusts it next.
//
// This exists because a comment audit of this tree found ~25 factually wrong comments, and the
// wrongness was structural rather than careless: a declaration inserted between a doc block and
// its target, a symbol attributed to the file it used to live in, a path to a file that has
// been deleted. src/ui.mjs is the worst case and the reason the check exists at all -- a
// 5,517-line IIFE inside a template literal, the one place in this tree no linter, type
// checker or dead-code pass can see -- but it is not the only one: the audit's stale symbols
// were fixed in anchor, board, styles, markdown, prose-check and render, and test/ carries the
// same class (four test files needed the same fix), which is why test/ is audited here and not
// merely read.
//
// FIVE RULES. Each one is (a) a pure function of the file list, so that (b) a floor can assert
// it has a subject at all, and (c) an ablation can plant a defect of its class and prove the
// rule reports that exact site. All three parts matter together: a rule whose extractor stops
// matching passes silently, which is worth less than no rule. Replacing every `/**` with `/*`
// across src/ -- any formatter pass -- used to take this file's block count from 385 to 0 with
// no change in output. The floors are what make that loud.
//
//   1. a `/** */` block sits above the declaration it names. Twelve blocks had drifted because
//      a declaration was inserted between a block and its target, leaving each one reading as
//      documentation for its neighbour.
//   2. every repo path a comment cites resolves to a file that exists. Eight sites cited a
//      check file that left the repo with its subject.
//   3. a symbol a comment attributes to a named file appears in that file's code. The stranded
//      extraction left seven pointers naming src/server.mjs for code now in src/stranded.mjs,
//      and the repair for a symbol that is gone everywhere is to stop attributing it: a
//      deleted symbol has no file, so the sentence should not claim one.
//   4. a symbol a comment reaches for as `x` above/below, or as this file's `x`, resolves in
//      this file. That is the form src/server.mjs's `commit` used for a `persist` that had moved
//      to src/stranded.mjs -- a load-bearing pointer, since it anchors a two-sided
//      read-modify-write invariant that nothing but prose protects.
//
// Restored the seven real pointers finding 4 left behind (`git show 603f203`), the rules catch
// five: `standingBanner` and `terminate` in src/notify.mjs, `waitingRounds` in src/ui.mjs and
// `persist` in test/check-http.mjs on rule 3, and the "its own `persist`, above" inside
// src/server.mjs's own `commit` on rule 4. (Writing that last one out as an attribution here
// made rule 3 report this very header, which is the check auditing itself working correctly.)
// The two they miss, stated so nobody has to rediscover them: `(src/server.mjs's announce)` is a
// bare lowercase word and fails the shape filter that keeps `src/badge.mjs's doc` out (widening
// that filter to "declared somewhere in the tree" was measured and produces 30-plus accusations
// on `own`, `doc`, `client`, `table`), and `So, like \`persist\`, swallow per board` names no
// scope at all, so it is nothing's subject. Where a rule's ablation below could be built from
// restored text rather than invented text, it was; each one says which it is.
//
// TWO RULES WERE DELETED rather than shipped, because neither could be made both precise and
// non-vacuous, and a rule that cries wolf gets the whole file deleted:
//
//   - "no comment names a repo symbol that no longer exists", judged against every identifier
//     appearing outside a comment in the tree. It cannot tell a deleted symbol from a platform
//     API: two ordinary comment lines in src/badge.mjs produce four accusations
//     (`queueMicrotask`, `reportError`, `userAgentData`, `structuredClone`), and five names
//     pass today only because some test file happens to mention them -- deleting one assertion
//     in test/check-install.mjs turns a correct comment in src/store.mjs red. Making it quiet
//     means enumerating the web platform, which is an ignore list standing in for a filter.
//     Rules 3 and 4 keep the half of it that is decidable: when a comment names the scope a
//     symbol lives in, the claim can be checked, and platform APIs are never written that way.
//     What is lost with it: a bare `` `someGoneFunction` `` with no scope named.
//   - "no comment states a numeric limit its own constant contradicts". Measured three ways on
//     this tree: bound per line, it turns red on a pure reflow of the correct comment at
//     src/ui.mjs:4793 and blames `TTL_MS` inside `DEFAULT_HANDOFF_TTL_MS`; bound per comment
//     block, 5 of the 10 constants whose block states any duration state a DIFFERENT one
//     truthfully ("a deadline 400ms away" beside a one-hour ceiling); bound by proximity to
//     the constant's own name, which is the only precise form, it has zero subjects in the
//     whole tree. The house style states durations in prose sentences ("up to an hour",
//     "forty minutes") a paragraph away from any constant, so the digits-beside-the-name shape
//     the rule needs does not occur. The one live instance of exactly this defect class --
//     src/stranded.mjs's exit hook, documented as forty minutes against a one-hour
//     `CLICK_LIFETIME_MAX_MS` -- is invisible to every variant, spelled in words in a header.
//
// Widening any rule below means first proving the wider version stays quiet on this tree.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

// --- the tree -----------------------------------------------------------------
//
// src/vendor/ is pinned third-party code (ADR.md entry 62): not ours to comment on.
// `.c` and `.m` are in, because bin/launcher.c and bin/notify.m are the two files no JS
// tooling sees at all -- the same argument that makes src/ui.mjs the point of this check.
function filesUnder(dirs, exts) {
  const out = [];
  const walk = dir => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'vendor' && e.name !== 'node_modules') walk(join(dir, e.name));
      } else if (exts.some(x => e.name.endsWith(x))) out.push(join(dir, e.name));
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

const FILES = filesUnder(['src', 'bin', 'test'], ['.mjs', '.js', '.c', '.m']).map(rel => ({
  rel,
  lines: readFileSync(join(ROOT, rel), 'utf8').split('\n'),
}));

check('the tree being audited is the whole tree', () => {
  assert.ok(FILES.length >= 60, `expected at least 60 files under src/, bin/ and test/, found ${FILES.length}`);
  for (const must of ['src/ui.mjs', 'src/styles.mjs', 'bin/launcher.c', 'bin/notify.m']) {
    assert.ok(FILES.some(f => f.rel === must), `${must} is not being read -- it is one of the files this check exists for`);
  }
});

// --- comment extraction --------------------------------------------------------
//
// A comment line's text: a `//` line (not a `://` inside a URL) or a line inside a block.
function commentText(line) {
  const m = line.match(/(?:^|[^:])\/\/(.*)$/) || line.match(/^\s*\*(.*)$/) || line.match(/\/\*\*?(.*)$/);
  return m ? m[1] : null;
}

/** Contiguous comment lines, joined into one string. Matching per line makes a rule's verdict
 * depend on where the author happened to wrap: reflowing seven correct lines used to turn this
 * suite red without a word changing. A run is the unit an author writes a sentence in. */
function commentRuns(lines) {
  const runs = [];
  let cur = null;
  lines.forEach((line, i) => {
    const text = commentText(line);
    if (text === null) { cur = null; return; }
    if (cur) cur.text += ' ' + text;
    else runs.push((cur = { start: i + 1, text }));
  });
  return runs;
}

// --- resolving a name inside a file --------------------------------------------
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const codeCache = new Map();
/** A file's code with its comments removed, or null if there is no such file. Comments are
 * removed on purpose: a symbol that survives only in other comments is not evidence that the
 * symbol exists, which is precisely the drift being looked for. */
function codeOf(rel) {
  if (!codeCache.has(rel)) {
    const at = join(ROOT, rel);
    codeCache.set(rel, existsSync(at) ? stripComments(readFileSync(at, 'utf8')) : null);
  }
  return codeCache.get(rel);
}
const wordBoundary = name => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
/** true, false, or null for "no such file". Word-bounded, so `TTL_MS` does not match inside
 * `DEFAULT_HANDOFF_TTL_MS` and blame a module that has nothing to do with it. */
function nameInCode(rel, name) {
  const code = codeOf(rel);
  return code === null ? null : wordBoundary(name).test(code);
}

// A repo-relative path, ending at the first real extension: `.m` must not swallow `.md`, and
// `src/render.mjs/ui.mjs/...` in prose is a slash-separated list, not one path.
const PATH = String.raw`(?:src|bin|test|examples|skills)\/[\w./-]*?\.(?:mjs|cjs|json|html|css|md|js|sh|c|m)(?![A-Za-z0-9])`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;

/** Rules 3 and 4 read a name out of English prose, so they need to know a symbol from a word.
 * A backticked span is this repo's own marker and is taken at face value. A BARE name is only
 * taken when its shape settles it: an internal camel hump or an underscore. That is what keeps
 * `src/badge.mjs's doc` and `src/theme.mjs's three` out, and it is also the one place src/ui.mjs
 * can be reached at all -- it is a template literal, so it carries no backticks anywhere in its
 * 2,976 comment lines, and `waitingRounds (src/badge.mjs)` is the form it has to use. The
 * cost, stated rather than hidden: a bare lowercase single word (`persist`, `announce`) is not
 * a subject unless it is backticked. */
const identifierShaped = name => /[a-z][A-Z]/.test(name) || name.includes('_');

// --- rule 1: a doc block precedes the declaration it names ---------------------

// A declaration on one line, in any shape this tree uses: keyword forms, plus object-method
// and object-property shorthand (`mint(target) {`), which is how src/handoff.mjs,
// src/pomodoro.mjs, src/server.mjs and src/stranded.mjs shape their APIs. The shorthand
// alternative cannot be allowed to match a keyword: `return foo(`, `if (`, `switch (` are not
// declarations, and an earlier version of this pattern resolved 102 of 384 blocks to one of
// them because its optional prefix could match the empty string.
const DECL_KEYWORD = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)/;
const DECL_MEMBER = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:)/;
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'catch', 'do', 'else', 'try', 'case', 'typeof',
  'new', 'await', 'delete', 'void', 'throw', 'yield', 'in', 'of', 'default', 'export',
  'import', 'function', 'const', 'let', 'var', 'class', 'this', 'super',
]);
function declarationOn(line) {
  const keyword = line.match(DECL_KEYWORD);
  if (keyword) return keyword[1];
  const member = line.match(DECL_MEMBER);
  return member && !KEYWORDS.has(member[1]) ? member[1] : null;
}

/** Every name this tree declares with a declaration KEYWORD, at any indentation. Used in one
 * place only: rule 4's hatch, to tell a symbol from a field a comment names in prose.
 * Deliberately not `DECL_MEMBER` -- `pid:` inside a record literal would make every documented
 * field a declaration, and that is precisely the distinction the hatch turns on. */
const DECLARED = new Set();
for (const { lines } of FILES) {
  for (const line of lines) {
    const m = line.match(DECL_KEYWORD);
    if (m) DECLARED.add(m[1]);
  }
}
// Top level only: column 0. Parameters and block-scoped locals are indented, and excluding
// them is the single filter that takes rule 1 from 124 false positives to 2.
const DECL_TOP = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s+|const\s+|class\s+)([A-Za-z_$][\w$]*)/;

function docBlocksOf(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\/\*\*/.test(lines[i])) continue;
    let j = i;
    while (j < lines.length && !/\*\//.test(lines[j])) j++;
    let k = j + 1;
    while (k < lines.length && lines[k].trim() === '') k++;
    // Everything down to the next blank line is one declaration group. A block sitting above
    // `const rawFetch = globalThis.fetch;` immediately followed by `function fetch(...)` is
    // documenting the pair, and naming the second half of it is not drift.
    const group = new Set();
    for (let g = k; g < lines.length && lines[g].trim() !== ''; g++) {
      const d = declarationOn(lines[g]);
      if (d) group.add(d);
    }
    blocks.push({
      start: i + 1,
      end: j + 1,
      body: lines.slice(i, j + 1).join('\n'),
      above: declarationOn(lines[k] || ''),
      aboveLine: k + 1,
      group,
    });
  }
  return blocks;
}

/** The block's opening sentence, with the comment furniture stripped. A doc block here names
 * its subject in its first sentence if it names it at all; a name appearing further down is a
 * cross-reference ("see `handleWait`", "the gate below"), which is why rule 1 reads only this
 * much. */
function firstSentence(body) {
  const flat = body.replace(/^\s*\/\*\*/, '').replace(/\*\/\s*$/, '').replace(/^\s*\*/gm, '').replace(/\s+/g, ' ').trim();
  const stop = flat.search(/\.(\s|$)/);
  return stop === -1 ? flat : flat.slice(0, stop + 1);
}

const NEARBY_LINES = 150;

/** Every doc block whose opening sentence names a top-level declaration that is NOT the one it
 * sits above, is not documented by a block of its own, and is close enough below that a block
 * having slid up past a newly-inserted declaration is the likely story. Also reports the
 * pipeline counts, so the floor below can see whether the extractor is still matching. */
function orphanedDocBlocks(files) {
  const orphans = [];
  let blocks = 0;
  let resolved = 0;
  let named = 0;
  for (const { rel, lines } of files) {
    const all = docBlocksOf(lines);
    const topDecls = new Map();
    lines.forEach((l, i) => {
      const m = l.match(DECL_TOP);
      if (m && !topDecls.has(m[1])) topDecls.set(m[1], i + 1);
    });
    const documented = new Set(all.map(b => b.above).filter(Boolean));
    for (const b of all) {
      blocks++;
      if (!b.above) continue;
      resolved++;
      // The block talks about what it sits above: correct by construction.
      if (wordBoundary(b.above).test(b.body)) continue;
      const opening = firstSentence(b.body);
      for (const name of new Set([...opening.matchAll(/`([A-Za-z_$][\w$]*)`/g)].map(x => x[1]))) {
        if (name === b.above || b.group.has(name) || !topDecls.has(name)) continue;
        named++;
        if (documented.has(name)) continue;
        const at = topDecls.get(name);
        if (at <= b.end || at - b.end > NEARBY_LINES) continue;
        orphans.push(`${rel}:${b.start}-${b.end} opens on \`${name}\` (declared :${at}, itself undocumented) but sits above \`${b.above}\` at :${b.aboveLine}`);
      }
    }
  }
  return { orphans, blocks, resolved, named };
}

const RULE1 = orphanedDocBlocks(FILES);

check('rule 1 has a subject: doc blocks are found, resolved to declarations, and read for names', () => {
  assert.ok(RULE1.blocks >= 400, `expected at least 400 /** */ blocks, found ${RULE1.blocks} -- the block scanner stopped matching, so rule 1 is inert`);
  assert.ok(RULE1.resolved / RULE1.blocks >= 0.9,
    `only ${RULE1.resolved} of ${RULE1.blocks} blocks resolved to a declaration -- the declaration pattern stopped matching, so rule 1 is judging nothing`);
  assert.ok(RULE1.named >= 15,
    `only ${RULE1.named} opening sentences name a top-level declaration other than their own subject -- rule 1 has no candidates left to judge`);
});

check('every /** */ block precedes the declaration it names', () => {
  assert.deepEqual(RULE1.orphans, [], `\n     ${RULE1.orphans.join('\n     ')}\n     A declaration was inserted between a doc block and its target. Move the block down past it.`);
});

check('rule 1 reports a block that has slid above a newly-inserted declaration, and only then', () => {
  // The defect, planted: a block that opens on `plantedTarget` while sitting above the
  // declaration that was inserted under it.
  const drifted = [{
    rel: 'test/(planted)',
    lines: ['/** `plantedTarget` mints one. */', 'function plantedNeighbour() {}', '', 'export function plantedTarget() {}'],
  }];
  assert.deepEqual(orphanedDocBlocks(drifted).orphans, [
    'test/(planted):1-1 opens on `plantedTarget` (declared :4, itself undocumented) but sits above `plantedNeighbour` at :2',
  ], 'a block naming a declaration below the one it sits above must be reported');
  // The same block, in the right place: silent.
  const correct = [{
    rel: 'test/(planted)',
    lines: ['function plantedNeighbour() {}', '', '/** `plantedTarget` mints one. */', 'export function plantedTarget() {}'],
  }];
  assert.deepEqual(orphanedDocBlocks(correct).orphans, [], 'a block sitting above its own target must stay silent');
});

// --- ablation scaffolding for rules 2-4 ----------------------------------------
//
// Rules 2, 3 and 4 read comment prose, so their defects can be planted in the real tree: one
// comment line appended to one real file, and the rule must report that file at that line.
// Nothing is written to disk -- `FILES` is the only input, and this returns a copy of it.
//
// The comment marker is assembled at run time rather than typed. This file is one of the files
// the rules audit, and a literal marker in front of these fixtures would turn each of them into
// a comment in this file's own source -- so every planted defect would be reported here as
// well, and the rules would be reading their own test data as if it were prose. (The same shape
// silently killed the ignore list the previous version of this file carried: `stripComments`
// removes comments but not string literals, so a name mentioned in a fixture counted as live.)
//
// Where git history holds a real instance of a rule's defect class, the fixture below is that
// text rather than an invention -- a planted site proves the reporting path works, a restored one
// proves the rule would have caught the thing it was written for. Each fixture says which it is.
// An array plants a multi-line run, which matters: rule 4's defect is only itself when both of
// the run's mentions of the symbol are present.
const MARK = `${'/'.repeat(2)} `;
function withPlantedComment(rel, text) {
  const target = FILES.find(f => f.rel === rel);
  assert.ok(target, `cannot plant into ${rel}: it is not in the scanned tree`);
  const planted = (Array.isArray(text) ? text : [text]).map(t => MARK + t);
  return {
    files: FILES.map(f => (f.rel === rel ? { rel, lines: [...f.lines, ...planted] } : f)),
    at: `${rel}:${target.lines.length + 1}`,
  };
}

// --- rule 2: a cited repo path exists ------------------------------------------
const PATH_CITATION = new RegExp(String.raw`(?:^|[\s(\`'"\[])(` + PATH + ')', 'g');

function deadPathCitations(files) {
  const dead = [];
  let cited = 0;
  for (const { rel, lines } of files) {
    for (const run of commentRuns(lines)) {
      for (const m of run.text.matchAll(PATH_CITATION)) {
        cited++;
        if (!existsSync(join(ROOT, m[1]))) dead.push(`${rel}:${run.start} cites ${m[1]}, which does not exist`);
      }
    }
  }
  return { dead, cited };
}

const RULE2 = deadPathCitations(FILES);

check('rule 2 has a subject: comments in this tree cite repo paths', () => {
  assert.ok(RULE2.cited >= 800, `expected at least 800 repo-path citations in comments, found ${RULE2.cited} -- the path pattern stopped matching, so rule 2 is inert`);
});

check('every repo path a comment cites exists', () => {
  assert.deepEqual(RULE2.dead, [], `\n     ${RULE2.dead.join('\n     ')}\n     The file moved or was deleted. Repoint the citation, or drop the path: a name with no path claims no location.`);
});

check('rule 2 reports a path that no longer resolves, and passes one that does', () => {
  const gone = withPlantedComment('src/badge.mjs', 'and the rest of it is in src/no-such-module.mjs');
  assert.deepEqual(deadPathCitations(gone.files).dead, [`${gone.at} cites src/no-such-module.mjs, which does not exist`]);
  const live = withPlantedComment('src/badge.mjs', 'and the rest of it is in src/stranded.mjs');
  assert.deepEqual(deadPathCitations(live.files).dead, [], 'a path that resolves must stay silent');
});

// --- rule 3: a symbol attributed to a file appears in that file ----------------
//
// The three forms this repo attributes in. The possessive form must not swallow a nested one:
// `` `EventSource` (test/dom-stand-in.mjs's `StandInEventSource`) `` attributes
// StandInEventSource, not EventSource, so a path followed by `'s` belongs to the possessive
// match alone.
const ATTR_POSSESSIVE = new RegExp(`(${PATH})'s\\s+(\`?)(${NAME})\\2`, 'g');
const ATTR_TICKED = new RegExp('`(' + NAME + ")`(?:\\(\\))?\\s*(?:\\(|,\\s*)(" + PATH + ")(?!'s)", 'g');
const ATTR_BARE = new RegExp('\\b(' + NAME + ')(?:\\(\\))?\\s+\\((' + PATH + ")\\)(?!'s)", 'g');

function misattributedSymbols(files) {
  const wrong = [];
  let subjects = 0;
  for (const { rel, lines } of files) {
    for (const run of commentRuns(lines)) {
      const seen = new Set();
      const judge = (file, name, ticked) => {
        if (!ticked && !identifierShaped(name)) return;
        if (seen.has(`${file}|${name}`)) return;
        seen.add(`${file}|${name}`);
        subjects++;
        const found = nameInCode(file, name);
        if (found === true) return;
        wrong.push(found === null
          ? `${rel}:${run.start} attributes \`${name}\` to ${file}, which does not exist`
          : `${rel}:${run.start} attributes \`${name}\` to ${file}, whose code does not contain it`);
      };
      // The backticks are a captured pair, so a backticked possessive is taken at face value
      // like any other ticked span. Reading them as optional-and-ignored used to drop
      // `` src/stranded.mjs's `terminate` `` on the shape filter, which is for BARE names.
      for (const m of run.text.matchAll(ATTR_POSSESSIVE)) judge(m[1], m[3], m[2] === '`');
      for (const m of run.text.matchAll(ATTR_TICKED)) judge(m[2], m[1], true);
      for (const m of run.text.matchAll(ATTR_BARE)) judge(m[2], m[1], false);
    }
  }
  return { wrong, subjects };
}

const RULE3 = misattributedSymbols(FILES);

check('rule 3 has a subject: comments in this tree attribute symbols to files', () => {
  assert.ok(RULE3.subjects >= 200, `expected at least 200 file-attributed symbols, found ${RULE3.subjects} -- the attribution patterns stopped matching, so rule 3 is inert`);
});

check('every symbol a comment attributes to a file appears in that file', () => {
  assert.deepEqual(RULE3.wrong, [], `\n     ${RULE3.wrong.join('\n     ')}\n     The code moved, or the symbol is gone. Repoint the attribution at where it lives now; if it lives nowhere, drop the file from the sentence rather than naming a file it was never in.`);
});

check('rule 3 reports a symbol attributed to the wrong file, and passes the right one', () => {
  // RESTORED, src/notify.mjs at 603f203: `standingBanner` had moved to src/stranded.mjs.
  const ticked = withPlantedComment('src/notify.mjs', [
    "so a board's announced marker no longer stands for anything on screen (src/server.mjs's",
    '`standingBanner`).',
  ]);
  assert.deepEqual(misattributedSymbols(ticked.files).wrong,
    [`${ticked.at} attributes \`standingBanner\` to src/server.mjs, whose code does not contain it`]);
  // RESTORED, src/notify.mjs at 603f203. A backticked possessive: read as a bare name it fell
  // through the shape filter, since `terminate` is one lowercase word.
  const lowercase = withPlantedComment('src/notify.mjs',
    "delivered banner when the reviewer comes back (src/server.mjs's `terminate`). Node");
  assert.deepEqual(misattributedSymbols(lowercase.files).wrong,
    [`${lowercase.at} attributes \`terminate\` to src/server.mjs, whose code does not contain it`]);
  // RESTORED, src/ui.mjs at 603f203. The bare form, which is the only one src/ui.mjs can use: no
  // backticks in a template literal, so a rule that required them could never read the file this
  // check exists for.
  const bare = withPlantedComment('src/ui.mjs', 'waitingRounds (src/theme.mjs) asks, so the click lands on the round the');
  assert.deepEqual(misattributedSymbols(bare.files).wrong,
    [`${bare.at} attributes \`waitingRounds\` to src/theme.mjs, whose code does not contain it`]);
  // The same three sentences as they read now: silent. The first names a different symbol
  // than its ablation above, because `standingBanner` did not just move -- ADR.md entry 74
  // deleted it, and the repair for a symbol that is gone everywhere is to attribute a
  // symbol that exists. `nextToAnnounce` is what took over the question it answered.
  for (const fixed of [
    ["so a board's announced marker no longer stands for anything on screen (src/stranded.mjs's", '`nextToAnnounce`).'],
    "delivered banner when the reviewer comes back (src/stranded.mjs's `terminate`). Node",
    'waitingRounds (src/badge.mjs) asks, so the click lands on the round the',
  ]) {
    assert.deepEqual(misattributedSymbols(withPlantedComment('src/notify.mjs', fixed).files).wrong, [],
      `a correct attribution must stay silent: ${JSON.stringify(fixed)}`);
  }
});

// --- rule 4: a scope-local reference resolves in its own file -------------------
//
// "above", "below" and "this file's" name a scope explicitly, and the scope is this file. The
// target may be prose rather than code -- src/board.mjs documents a record's `pid` field and
// then points at it "below" -- so a run that names its own subject again is allowed to resolve
// it, but ONLY for a name this tree declares nowhere.
//
// That gate is the whole of it. Without it the hatch defeated the rule on the one defect it was
// built for: src/server.mjs:944-960 is a single comment run that says "its own `persist`, above"
// and then, eleven lines later, "So, like `persist`, swallow per board". `persist` had moved to
// src/stranded.mjs, and the run's own second mention excused the first -- a name kept alive by
// the very drift being looked for, which is what an earlier revision of this comment predicted
// and the code then did. A name that IS declared somewhere is a symbol, so "above" is a claim
// about where it lives and can simply be wrong; a name declared nowhere is a field being
// described, and there is nothing for it to be wrong about.
const SCOPE_DIRECTIONAL = new RegExp('`(' + NAME + ')`(?:\\(\\))?,?\\s+(?:just\\s+)?(?:above|below)\\b', 'g');
const SCOPE_THIS_FILE = new RegExp("th(?:is|e) (?:file|module)'s (?:own )?`(" + NAME + ')`', 'g');

function unresolvedLocalReferences(files) {
  const lost = [];
  let subjects = 0;
  for (const { rel, lines } of files) {
    for (const run of commentRuns(lines)) {
      for (const re of [SCOPE_DIRECTIONAL, SCOPE_THIS_FILE]) {
        for (const m of run.text.matchAll(re)) {
          subjects++;
          const name = m[1];
          if (nameInCode(rel, name) === true) continue;
          // A pointer inside one run of prose, at a field that run describes and that nothing
          // in this tree declares.
          if (!DECLARED.has(name) && wordBoundary(name).test(run.text.replace(m[0], ' '))) continue;
          lost.push(`${rel}:${run.start} points at \`${name}\` in this file, which is not here`);
        }
      }
    }
  }
  return { lost, subjects };
}

const RULE4 = unresolvedLocalReferences(FILES);

check('rule 4 has a subject: comments in this tree point at symbols in their own file', () => {
  assert.ok(RULE4.subjects >= 50, `expected at least 50 above/below/this-file references, found ${RULE4.subjects} -- the pattern stopped matching, so rule 4 is inert`);
});

check('every above/below/this-file reference resolves in its own file', () => {
  assert.deepEqual(RULE4.lost, [], `\n     ${RULE4.lost.join('\n     ')}\n     The symbol is in another file now. Name that file instead of saying "above": a reader who greps this one finds a comment and no code.`);
});

// RESTORED, src/server.mjs:944-960 at 603f203, trimmed to the two sentences that carry the two
// `persist` mentions and the bare `//` line that joins them into ONE run. The run is the fixture:
// a single-line version of this defect is caught by any implementation, and the one that shipped
// was defeated by the second mention. `persist` had moved to src/stranded.mjs.
const MOVED_PERSIST_RUN = [
  '`STRANDED_BANNER` record onto this same board (its own `persist`, above, already',
  'defends that field against this exact writer, by name, in its own comment). This',
  'is the reverse direction: without it, this closure\'s stale whole-board write',
  'would silently erase that record.',
  '',
  'with it. So, like `persist`, swallow per board: the comment simply stays',
  'undelivered and rides the next `/wait` on the thread instead.',
];

check('rule 4 reports a local pointer at a symbol in another file, and passes one that is here', () => {
  const gone = withPlantedComment('src/server.mjs', MOVED_PERSIST_RUN);
  assert.deepEqual(unresolvedLocalReferences(gone.files).lost,
    [`${gone.at} points at \`persist\` in this file, which is not here`],
    'the run mentions `persist` twice; the second mention must not excuse the first');
  const here = withPlantedComment('src/stranded.mjs', MOVED_PERSIST_RUN);
  assert.deepEqual(unresolvedLocalReferences(here.files).lost, [], 'a pointer at a symbol that really is in this file must stay silent');
});

check('rule 4 still resolves a documented field against its own run, but only one nothing declares', () => {
  // The hatch's genuine case, in the shape src/board.mjs:1066-1082 has it: a record's fields are
  // named in prose, pointed at from inside the same run, and declared nowhere as code.
  const prose = withPlantedComment('src/badge.mjs', [
    'at     when the banner went up. Also what bounds `nobodyDeclaresThisField` below: a',
    '       process that started before this did is not the one this record names.',
    '       `nobodyDeclaresThisField` is null on the fallback, which spawns nothing.',
  ]);
  assert.deepEqual(unresolvedLocalReferences(prose.files).lost, [],
    'a field this tree declares nowhere, described by the run that points at it, is not drift');
  // And the gate: the identical prose about a name that IS declared somewhere is reported, because
  // then "below" is a claim about where a symbol lives.
  const symbol = withPlantedComment('src/badge.mjs', [
    'at     when the banner went up. Also what bounds `createStrandedWatch` below: a',
    '       process that started before this did is not the one this record names.',
    '       `createStrandedWatch` is null on the fallback, which spawns nothing.',
  ]);
  assert.deepEqual(unresolvedLocalReferences(symbol.files).lost,
    [`${symbol.at} points at \`createStrandedWatch\` in this file, which is not here`]);
});

// --- rule 5: nothing tracked names a local-only document ------------------------
//
// .gitignore keeps the working documents local -- the specs, the ticket lists, the
// scratch list, the audit reports under the findings directory -- and states the rule
// this check enforces: nothing tracked may cite one of them by name, because the
// pointer resolves only in the checkout that happens to hold the file. 250-odd such
// citations were swept out of this tree in one pass; this rule is what keeps the next
// spec from depositing more.
//
// The subject is the TRACKED tree, not FILES above: the rule is about what a clone
// receives, so it reads the tracked list from git and scans whole files rather than
// comment runs -- a test name is a string, not a comment, and dangled just the same.
// The pattern is concatenated from pieces so this file's own source stays out of its
// verdict.
const LOCAL_ONLY = new RegExp(
  String.raw`\b(?:SPEC|TICKETS)_[A-Z_]+\.md` + '|' +
  String.raw`\bTODO\.md` + '|' +
  String.raw`\bfindings\/[\w.-]+`, 'g');

function localDocCitations(entries) {
  const cited = [];
  for (const { rel, text } of entries) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(LOCAL_ONLY)) cited.push(`${rel}:${i + 1} names ${m[0]}`);
    });
  }
  return cited;
}

// .gitignore is exempt: it declares the patterns this rule enforces. Binary files are
// skipped as noise; a file tracked but absent on disk (mid-operation) is skipped
// rather than crashing the run.
const TRACKED = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter(rel => rel !== '.gitignore' && !/\.(?:png|icns)$/.test(rel) && existsSync(join(ROOT, rel)))
  .map(rel => ({ rel, text: readFileSync(join(ROOT, rel), 'utf8') }));

check('rule 5 has a subject: the tracked tree is listed and read', () => {
  assert.ok(TRACKED.length >= 60, `expected at least 60 tracked files, found ${TRACKED.length} -- the tracked list stopped answering, so rule 5 is inert`);
  for (const must of ['src/ui.mjs', 'README.md', 'skills/claude-board/SKILL.md']) {
    assert.ok(TRACKED.some(f => f.rel === must), `${must} is not in the tracked list rule 5 reads`);
  }
});

check('no tracked file names a local-only document', () => {
  const cited = localDocCitations(TRACKED);
  assert.deepEqual(cited, [], `\n     ${cited.join('\n     ')}\n     The named file is gitignored: a clone cannot follow the pointer. Cite an ADR.md entry or state the fact in place (.gitignore, "Working documents, kept local").`);
});

check('rule 5 reports each local-only name, and stays silent on tracked ones', () => {
  const planted = [{
    rel: 'src/x.mjs',
    text: 'per SPEC' + '_HEADER.md ticket 3, see findings' + '/audit.md\nADR.md entry 45 and DESIGN.md stay.\nTODO' + '.md too',
  }];
  assert.deepEqual(localDocCitations(planted), [
    'src/x.mjs:1 names SPEC' + '_HEADER.md',
    'src/x.mjs:1 names findings' + '/audit.md',
    'src/x.mjs:3 names TODO' + '.md',
  ], 'the two dangling names and the scratch list must be reported; the ADR and DESIGN citations must not');
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall comment checks ok');
process.exit(failed ? 1 : 0);
