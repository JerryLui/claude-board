// test/check-harness-globals.mjs check: keeps QUIRKS.md's "a `new Function` harness
// inherits the host's globals" trap fixed shut, permanently rather than by one-time
// sweep. `new Function('document', 'window', 'location', ui)` hands a client script
// only the names listed as parameters -- every name left off falls through to
// whatever the node process running the check happens to expose, and node has shipped
// a global `EventSource` behind a flag since 22.x. A harness that forgets to declare
// 'EventSource' passes on a property of the interpreter, not of the code, and nothing
// catches that until a node upgrade turns the guard the wrong way. Every site in this
// directory was converted to declare the name (QUIRKS.md, same entry); this file is
// what stops the next one from reintroducing the gap.
//
// Two rules, both scanned across every test/*.mjs file's own source text -- this file
// included, deliberately, since a rule that exempts itself from its own scan is a rule
// half-checked:
//
// Rule 1 -- no live assignment to a global `EventSource` survives in test/. That shape
// is the one converted away by this fix: once a site declares 'EventSource' as a
// parameter, the parameter SHADOWS the global, so a stand-in left on the global
// silently stops arriving. Checked in every form the assignment could take --
// `globalThis.EventSource =` and `global.EventSource =` (Node's other name for the
// same object), bracket form (`globalThis['EventSource'] =`), any compound operator
// (`??=`, `+=`, ...), and `Object.defineProperty(globalThis, 'EventSource', ...)` --
// not just the one literal shape this fix happened to convert away.
//
// Rule 2 -- every call to the `Function` constructor -- `new Function(...)` or plain
// `Function(...)`, since the two behave identically and only one of them says `new` --
// whose body (its last argument) evaluates a whole client script top to bottom
// declares 'EventSource' among its earlier, parameter-name arguments. A body counts as
// "evaluates a whole script" if it is a bare identifier (`ui`, `indexScript`,
// `themeBootScript`, `scriptText`, ...), or STARTS with one (`indexScript + '; return
// relTime;'` runs indexScript in full before appending a return statement), or is a
// template literal whose first element is an interpolation (`` `${indexScript}\n;
// return ${name};` ``, same reasoning). A call with no parameter-name arguments at all
// -- the body is the call's ONLY argument -- is exempt regardless of what its body
// looks like: with no parameter list, there is no `document`/`window` for a real
// client script to read even if it wanted to, so a bare `new Function(src + '; return
// ' + name + ';')()` is always round-tripping one already-extracted function
// (test/check-pure.mjs's own `extractUiFunction`, `namedFunctionBody`-style helpers),
// never evaluating one script's full text -- the same reasoning as the `'return (' +
// fn.toString() + ')'` shape, just built by concatenating a variable instead of
// calling `.toString()`.
//
// Both rules scan each file's text with comments masked to a single space (so one
// inside a multi-line argument list can never glue two real tokens together, and can
// never smuggle prose past the parser either) and the CONTENTS of string/template
// literals kept verbatim but walked as one opaque span (so a quoted 'EventSource', or
// a `"` embedded in a regex literal, is read correctly rather than desyncing what
// looks like a string boundary for the rest of the file). A regex that only ever
// looked at one line at a time would also miss a call whose argument list spans
// several -- at least one genuinely does, in this directory -- so the scan below
// balances parens itself rather than matching a single line.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

// --- a small, purpose-built scanner, not a JS parser -----------------------------
// Just enough to (a) tell real code apart from comments and string/template content,
// so prose describing either trap shape is never mistaken for the shape itself, and
// (b) balance the parens of a `new Function(...)` call across however many lines it
// spans.

/** Returns the index just past a `//` or `/* *(/` comment starting at `text[i]`, or
 * null. Comments are the one non-code span every scan below DROPS rather than keeps
 * -- see `splitTopLevelArgs`, where keeping one verbatim would glue two real argument
 * tokens together across it. */
function commentSpanEnd(text, i) {
  const c = text[i], c2 = text[i + 1];
  if (c === '/' && c2 === '/') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl;
  }
  if (c === '/' && c2 === '*') {
    const close = text.indexOf('*/', i + 2);
    return close === -1 ? text.length : close + 2;
  }
  return null;
}

/** Returns the index just past a string, template, or regex literal starting at
 * `text[i]`, or null. Unlike a comment, this content is kept verbatim wherever it is
 * read back -- it can itself be the real argument text (a quoted `'EventSource'`, a
 * script body) -- but is still walked as one opaque span so nothing inside one (a
 * paren, a comma, a `"` in a regex character class) is mistaken for real code. */
function literalSpanEnd(text, i) {
  const c = text[i];
  if (c === '\'' || c === '"') return skipString(text, i, c);
  if (c === '`') return skipTemplate(text, i);
  if (c === '/' && precedesRegex(text, i)) return skipRegex(text, i);
  return null;
}

/** If `text[i]` opens a comment or a string/template/regex literal, returns the
 * index just past its end; otherwise returns null. The definition of "non-code" that
 * `maskNonCode` and `readBalancedArgs` share -- they only need to know THAT a span is
 * opaque, never which kind, so they use this composed form; `splitTopLevelArgs` needs
 * the distinction and calls `commentSpanEnd`/`literalSpanEnd` directly. Regex literals
 * matter here for more than being non-code themselves: this suite quotes attribute
 * values inside a handful of them (test/check-assets.mjs's `attrs.match(/\s(?:src|
 * href)="([^"]*)"/)`), and a scanner that does not recognise a regex as its own span
 * reads that embedded `"` as the start of a STRING instead -- desyncing quote-parity
 * for the rest of the file and masking out everything after it, including any real
 * `new Function(` call downstream. Caught by testing this file against the real
 * suite, not invented up front. */
function skipNonCodeSpan(text, i) {
  const commentEnd = commentSpanEnd(text, i);
  if (commentEnd !== null) return commentEnd;
  return literalSpanEnd(text, i);
}

function skipString(text, i, quote) {
  i++;
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

// Keywords after which a `/` starts a regex rather than dividing (the standard
// ambiguity in every JS tokenizer -- `return /x/` is a regex, `a / b` is not, and
// the only way to tell is what token precedes the slash).
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/** Whether the `/` at `text[i]` most likely opens a regex literal, judged from the
 * previous significant (non-whitespace) character: nothing, an operator, or an
 * opening bracket/comma/semicolon all mean an expression is expected next (regex);
 * a identifier/number/`)`/`]` means a value just ended (division). Not exact --
 * nothing short of a real parser is -- but exact enough for how this suite actually
 * writes regex literals (always right after `(`, `,`, `=` or another operator). */
function precedesRegex(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  const c = text[j];
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--;
    const word = text.slice(k + 1, j + 1);
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  if (c === ')' || c === ']') return false;
  return true;
}

/** From the `/` at `text[i]`, reads to the matching unescaped closing `/` (a `/`
 * inside a `[...]` character class never closes the regex) plus any trailing flag
 * letters, and returns the index just past it -- or, if no closing `/` appears before
 * a newline (an unterminated regex is a syntax error; a stray division is not), the
 * index of the `/` itself, so the caller falls back to treating it as an ordinary
 * character rather than swallowing the rest of the line. */
function skipRegex(text, i) {
  let j = i + 1;
  let inClass = false;
  while (j < text.length && text[j] !== '\n') {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') { inClass = true; j++; continue; }
    if (c === ']') { inClass = false; j++; continue; }
    if (c === '/' && !inClass) {
      j++;
      while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
      return j;
    }
    j++;
  }
  return i + 1;
}

/** Skips a whole template literal starting at its opening backtick, including any
 * `${...}` interpolations (which this scanner never looks inside -- nothing in this
 * suite hides a `Function(` call inside one, and treating the interpolation as
 * opaque here is the deliberate, named ceiling rather than a parser bug: it means a
 * call hidden that way would not be caught). */
function skipTemplate(text, i) {
  i++;
  while (i < text.length && text[i] !== '`') {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '$' && text[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i + 1;
}

/** Same length as `text`; every comment and the interior of every string/template/
 * regex literal is overwritten with spaces (newlines kept, so line numbers computed
 * against either string agree), so a search for real code on this text can never
 * land inside prose or a quoted example. Used for finding `Function(` call sites
 * (Rule 2), which never need to read INTO a string -- the call's own real argument
 * text is read back separately, from the unmasked file, once a real call site is
 * found this way. */
function maskNonCode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const end = skipNonCodeSpan(text, i);
    if (end !== null) {
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Same length as `text`; every comment is overwritten with spaces, but a string,
 * template, or regex literal is copied through VERBATIM -- still walked as one span
 * (so a `//` inside a URL string, say, is never mistaken for a comment start
 * partway through it), just not blanked. Rule 1 needs this distinction that Rule 2
 * does not: its own target can BE a string, `globalThis['EventSource'] = ...`, and
 * `maskNonCode` blanking that quoted key erases the very text the bracket-form
 * regex has to match, which is exactly the bug this second mask exists to avoid
 * (caught by testing the bracket-notation ablation below, not invented up front). */
function maskComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const commentEnd = commentSpanEnd(text, i);
    if (commentEnd !== null) {
      out += text.slice(i, commentEnd).replace(/[^\n]/g, ' ');
      i = commentEnd;
      continue;
    }
    const litEnd = literalSpanEnd(text, i);
    if (litEnd !== null) {
      out += text.slice(i, litEnd);
      i = litEnd;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/** From `start` (just after the opening paren of a call already consumed), balances
 * (), [], {} -- treating every comment and string/template/regex literal as one
 * opaque span, via `skipNonCodeSpan`, so nothing inside one can miscount -- until the
 * matching close paren. Returns the raw slice between them (real code, real quotes:
 * this runs on the UNMASKED text, since the actual argument list, 'EventSource'
 * included, is what the caller needs) and the index just past it. */
function readBalancedArgs(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const span = skipNonCodeSpan(text, i);
    if (span !== null) { i = span; continue; }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    i++;
  }
  return { argsText: text.slice(start, i - 1), end: i };
}

/** Splits a `new Function(...)`'s raw argument text on TOP-LEVEL commas only -- not
 * ones nested inside (), [], {}, a string, a template, or a regex -- and drops the
 * trailing empty segment a trailing comma before the close paren would otherwise
 * leave.
 *
 * A comment is DROPPED rather than kept (replaced with a single space, so it can
 * never glue two adjacent tokens together, e.g. `ui/**(/x` must not become the single
 * identifier `uix`): a body segment that happened to still contain a comment's own
 * text -- `// 'EventSource' intentionally omitted` mixed into what should have read
 * as the bare identifier `ui` -- used to fail every later shape test and silently
 * exempt the whole call, which is the exact class of false-negative this file exists
 * to prevent. A string/template/regex, by contrast, is kept byte for byte: it can BE
 * the argument the caller needs to read (a quoted `'EventSource'`, a template body). */
function splitTopLevelArgs(argsText) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  while (i < argsText.length) {
    const commentEnd = commentSpanEnd(argsText, i);
    if (commentEnd !== null) { cur += ' '; i = commentEnd; continue; }
    const litEnd = literalSpanEnd(argsText, i);
    if (litEnd !== null) { cur += argsText.slice(i, litEnd); i = litEnd; continue; }
    const c = argsText[i];
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; }
    else if (c === ')' || c === ']' || c === '}') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; i++; continue; }
    else cur += c;
    i++;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map(p => p.trim());
}

/** Whether a `new Function(...)` argument list's BODY (its trimmed last argument)
 * looks like it evaluates a whole client script, per this file's header comment:
 * a bare identifier, a body that STARTS with one (`indexScript + '...'`), or a
 * template literal whose first element is an interpolation (`` `${indexScript}...` ``).
 * A body starting with a quote or backtick-then-literal-text -- `'return (' + ...`,
 * `` `function foo() {${body}}` `` -- fails both checks and is correctly left alone:
 * the identifier's value is spliced into an expression or a hand-built wrapper, and
 * the script named by that identifier never runs top to bottom. */
function isScriptLikeBody(body) {
  if (/^`\$\{/.test(body)) return true;
  return /^[A-Za-z_$]/.test(body);
}

/** Every call to the `Function` constructor found in `text`'s real code -- `new
 * Function(...)` or plain `Function(...)` (the two behave identically; only a
 * "new"-less call would slip past a scan for just the first shape), comments and
 * string/template content masked out first so a call merely mentioned in prose is
 * invisible here, and a `.Function(...)` property access on some unrelated object
 * excluded via the negative lookbehind -- each as `{ line, args }`, `args` the
 * call's own top-level argument list in source order. */
function findFunctionCalls(text) {
  const masked = maskNonCode(text);
  const calls = [];
  const re = /(?<!\.)\b(?:new\s+)?Function\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const openParen = m.index + m[0].length - 1;
    const { argsText, end } = readBalancedArgs(text, openParen + 1);
    calls.push({ line: lineAt(text, m.index), args: splitTopLevelArgs(argsText) });
    re.lastIndex = end;
  }
  return calls;
}

function testFiles() {
  return readdirSync(TEST_DIR)
    .filter(f => f.endsWith('.mjs'))
    .sort()
    .map(f => path.join(TEST_DIR, f));
}

// Rule 1's target, in every shape the assignment could take: `globalThis` or Node's
// `global`, dot or bracket property access, any assignment operator (plain or
// compound -- `??=` included, since a declared parameter shadows the global either
// way and `??=` is exactly the operator someone reaching for "only if nothing's
// there yet" would pick), and `Object.defineProperty` as a wholly different call
// shape that reaches the same place a `=` would.
const GLOBAL_ES_ASSIGN_RE =
  /\b(?:globalThis|global)\s*(?:\.\s*EventSource\b|\[\s*(?:'EventSource'|"EventSource")\s*\])\s*(?:\*\*|<<|>>>|>>|&&|\|\||\?\?|[+\-*/%&|^])?=(?!=)/g;
const DEFINE_PROPERTY_RE =
  /\bObject\s*\.\s*defineProperty\s*\(\s*(?:globalThis|global)\s*,\s*(?:'EventSource'|"EventSource")/g;

async function main() {
  const files = testFiles();

  await check('no test/*.mjs file assigns a global EventSource', () => {
    const offenders = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const masked = maskComments(text);
      for (const re of [GLOBAL_ES_ASSIGN_RE, DEFINE_PROPERTY_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(masked))) offenders.push(`${path.basename(file)}:${lineAt(text, m.index)}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        `a global EventSource is still assigned at: ${offenders.join(', ')} -- ` +
        `declare 'EventSource' as a Function parameter and pass the stand-in as its argument instead`,
      );
    }
  });

  await check("every Function(...) call whose body evaluates a client script declares 'EventSource'", () => {
    const offenders = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { line, args } of findFunctionCalls(text)) {
        // No parameter-name arguments at all (the body is the call's only argument):
        // exempt regardless of the body's shape -- see this file's header comment on
        // why that always means round-tripping one already-extracted function, never
        // evaluating a whole script.
        if (args.length < 2) continue;
        const body = args[args.length - 1];
        if (!isScriptLikeBody(body)) continue;
        const paramNames = args.slice(0, -1);
        const declaresEventSource = paramNames.some(a => a === "'EventSource'" || a === '"EventSource"');
        if (!declaresEventSource) offenders.push(`${path.basename(file)}:${line} (body \`${body}\`)`);
      }
    }
    if (offenders.length) {
      throw new Error(`Function(...) evaluates a client script without declaring 'EventSource': ${offenders.join(', ')}`);
    }
  });

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all harness-globals checks ok');
}

main().catch(err => {
  console.error((err && err.stack) || err);
  process.exit(1);
});
