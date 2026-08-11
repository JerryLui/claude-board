// ADR.md single-source: every .agents/adr/*.md has exactly one ADR.md index row and
// ADR.md carries no entry bodies. An earlier audit
// flagged ADR.md and the 61 split .agents/adr/*.md files as a dual-source-of-truth
// drift risk -- ADR.md's own header already says it is meant to be a pure index
// ("This file is the index; read it, then open only the entries you need"), so this
// check pins that shape rather than re-deciding it: no filesystem/index mismatch, and
// no prose sneaking in after the table that would make ADR.md a second place a
// decision's reasoning could drift out of sync in.
//
// Static, no daemon, no network -- reads ADR.md and .agents/adr/*.md off disk.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adrDir = path.join(repoRoot, '.agents', 'adr');
const adrMdPath = path.join(repoRoot, 'ADR.md');

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

const entryFiles = readdirSync(adrDir).filter(f => f.endsWith('.md')).sort();
const adrMd = readFileSync(adrMdPath, 'utf8');
const lines = adrMd.split('\n');

// A table row: "| 42 | [Title](.agents/adr/0042-slug.md) | 2026-08-07 | accepted |"
const ROW_RE = /^\| (\d+) \| \[[^\]]+\]\(([^)]+)\) \| [^|]+ \| [^|]+ \|$/;
const HEADER_RE = /^\| # \| Decision \| Date \| Relations \|$/;
const SEPARATOR_RE = /^\|-+\|-+\|-+\|-+\|$/;

const headerIdx = lines.findIndex(l => HEADER_RE.test(l));

check('ADR.md has exactly one index table, introduced by the standard header row', () => {
  assert.ok(headerIdx !== -1, 'no "| # | Decision | Date | Relations |" header row found');
  const otherHeaders = lines.filter(l => HEADER_RE.test(l));
  assert.equal(otherHeaders.length, 1, 'more than one index-table header found -- ADR.md must carry a single table');
  assert.ok(SEPARATOR_RE.test(lines[headerIdx + 1]), `the line after the header must be the table separator, got: ${JSON.stringify(lines[headerIdx + 1])}`);
});

const rowLines = lines.slice(headerIdx + 2);
const rows = [];
check('every row after the table separator is a well-formed index row -- no prose, no heading, no entry body follows the table', () => {
  for (const line of rowLines) {
    if (line.trim() === '') continue; // trailing blank lines / EOF are fine
    assert.ok(ROW_RE.test(line), `line after the index table is not a table row (an entry body or stray heading would look like this): ${JSON.stringify(line)}`);
    rows.push(line.match(ROW_RE));
  }
  assert.ok(rows.length > 0, 'the index table has no rows at all');
});

check('nothing before the table reads as a per-entry body -- no other heading (##/###) appears anywhere in ADR.md', () => {
  const headings = lines.filter(l => /^#{2,3}\s/.test(l));
  assert.deepEqual(headings, [], `ADR.md must carry only its title (a single #), not per-entry headings: ${JSON.stringify(headings)}`);
});

check('every index row links a file that actually exists under .agents/adr/', () => {
  const missing = rows
    .map(m => m[2])
    .filter(link => !link.startsWith('.agents/adr/'))
    .concat(
      rows
        .map(m => m[2])
        .filter(link => link.startsWith('.agents/adr/') && !readdirSync(adrDir).includes(path.basename(link)))
    );
  assert.deepEqual(missing, [], `index row(s) link to a nonexistent file: ${JSON.stringify(missing)}`);
});

check('every .agents/adr/*.md file has exactly one index row', () => {
  const linkedBasenames = rows.map(m => path.basename(m[2]));
  const counts = new Map();
  for (const name of linkedBasenames) counts.set(name, (counts.get(name) || 0) + 1);

  const missingIndexRow = entryFiles.filter(f => !counts.has(f));
  assert.deepEqual(missingIndexRow, [], `these .agents/adr/ files have no ADR.md index row: ${JSON.stringify(missingIndexRow)}`);

  const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f);
  assert.deepEqual(duplicated, [], `these files have more than one ADR.md index row: ${JSON.stringify(duplicated)}`);

  const rowsWithNoFile = linkedBasenames.filter(f => !entryFiles.includes(f));
  assert.deepEqual(rowsWithNoFile, [], `these index rows link a file that is not under .agents/adr/: ${JSON.stringify(rowsWithNoFile)}`);
});

check('the row number matches the number the linked file itself is numbered under', () => {
  const mismatches = [];
  for (const m of rows) {
    const rowNum = m[1];
    const fileNum = path.basename(m[2]).match(/^(\d+)-/)?.[1];
    if (fileNum && String(Number(fileNum)) !== rowNum) mismatches.push(`row #${rowNum} links ${m[2]} (numbered ${fileNum})`);
  }
  assert.deepEqual(mismatches, [], `row number / filename number mismatch: ${JSON.stringify(mismatches)}`);
});

check('no two rows claim the same entry number', () => {
  const counts = new Map();
  for (const m of rows) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  const dup = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
  assert.deepEqual(dup, [], `entry number(s) with more than one row: ${JSON.stringify(dup)}`);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall ADR-index checks ok');
