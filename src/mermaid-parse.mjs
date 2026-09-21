// Parsing at the storage boundary has to use the browser's exact engine without
// giving its classic-script build the daemon's global object. A private context
// keeps Mermaid's globals and sanitizer probes contained, while its own microtask
// queue makes the promise-shaped parser usable by the board's synchronous path.

import vm from 'node:vm';
import { MERMAID_SOURCE } from './vendor/mermaid/index.mjs';

export const MERMAID_MAX_TEXT = 50_000;

// How much of a diagram any message is allowed to quote back, matching the hint cap
// in src/anchor.mjs.
const ECHO_MAX = 80;

// Mermaid appends the whole diagram after this, which is where the quoting starts.
const UNKNOWN_TYPE_PREFIX = 'No diagram type detected matching given configuration for text: ';

let engineContext;

function emptyElement() {
  return {};
}

function createSandbox() {
  class Element {}
  class Node {}
  class HTMLElement extends Element {}
  class HTMLFormElement extends HTMLElement {}
  class HTMLTemplateElement extends HTMLElement {}
  class NamedNodeMap {}

  const document = {
    nodeType: 9,
    createElement: emptyElement,
    createDocumentFragment: emptyElement,
    body: {},
    documentElement: {},
    addEventListener() {},
    querySelector() { return null; },
    getElementsByTagName() { return []; },
  };
  document.implementation = {
    createHTMLDocument() { return document; },
  };

  const sandbox = {
    TextEncoder,
    TextDecoder,
    structuredClone,
    setTimeout,
    clearTimeout,
    addEventListener() {},
    document,
    Element,
    Node,
    HTMLElement,
    HTMLFormElement,
    HTMLTemplateElement,
    NamedNodeMap,
    NodeFilter: {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function loadEngine() {
  const context = vm.createContext(createSandbox(), { microtaskMode: 'afterEvaluate' });
  vm.runInContext(MERMAID_SOURCE, context, { filename: 'mermaid.min.js' });
  vm.runInContext('mermaid.initialize({ startOnLoad: false })', context);
  return context;
}

function parseInContext(text) {
  engineContext ??= loadEngine();
  engineContext.__diagramText = text;
  engineContext.__diagramResult = undefined;
  vm.runInContext(`
    {
      const settleError = error => {
        const loc = error && error.hash && error.hash.loc;
        __diagramResult = {
          ok: false,
          name: String(error && error.name || ''),
          message: String(error && error.message || error),
          line: Number.isInteger(loc && loc.first_line) ? loc.first_line : null,
        };
      };
      try {
        mermaid.parse(__diagramText).then(
          () => { __diagramResult = { ok: true }; },
          settleError,
        );
      } catch (error) {
        settleError(error);
      }
    }
  `, engineContext);
  const result = engineContext.__diagramResult;
  engineContext.__diagramText = undefined;
  engineContext.__diagramResult = undefined;
  return result;
}

function firstLine(text) {
  try {
    return String(text).split(/\r?\n/, 1)[0];
  } catch {
    return '<unprintable diagram>';
  }
}

// Whatever quotes the diagram back -- the engine's unknown-type error, the fail-open
// log line -- quotes a prefix of it, never the diagram. A diagram is one line up to
// MERMAID_MAX_TEXT long, and its refusal travels into the agent's context while the
// log line travels to stderr: enough to recognise which diagram this is, not enough
// to carry a file the agent never asked to read.
// The cap counts code points, not code units: cutting mid-pair would put half a
// character in the refusal the agent reads, and a line whose characters fit the cap
// goes back whole however many code units it spends on them.
function echoOf(text) {
  const line = firstLine(text);
  if (line.length <= ECHO_MAX) return line;
  const points = Array.from(line);
  if (points.length <= ECHO_MAX) return line;
  return points.slice(0, ECHO_MAX - 1).join('') + '…';
}

function refusalFor(error) {
  const message = error?.message || '';
  const parse = message.match(/Parse error on line (\d+):/);
  if (parse) return { message: parse[0], line: Number(parse[1]) };

  const lexical = message.match(/Lexical error on line (\d+)\. Unrecognized text\./);
  if (lexical) return { message: lexical[0], line: Number(lexical[1]) };

  if (error?.name === 'UnknownDiagramError' || message.startsWith(UNKNOWN_TYPE_PREFIX)) {
    // The engine's own wording stays verbatim; only the diagram it appended is cut.
    if (message.startsWith(UNKNOWN_TYPE_PREFIX)) {
      const quoted = echoOf(message.slice(UNKNOWN_TYPE_PREFIX.length));
      return { message: UNKNOWN_TYPE_PREFIX + quoted, line: null };
    }
    return { message: echoOf(message), line: null };
  }

  if (/^(?:Edge|Text) limit exceeded\b/.test(message)) {
    return { message: message.split(/\r?\n/, 1)[0], line: null };
  }

  return null;
}

function logFailure(log, text, error) {
  const name = error?.name || 'Error';
  const message = echoOf(error?.message || error || 'unknown engine failure');
  log(`Diagram engine failed open for "${echoOf(text)}": ${name}: ${message}`);
}

// A parser defect must not turn into a false refusal: only Mermaid's recognised
// diagram errors are returned to the door. Load, sandbox, and unexpected engine
// failures stay observable through the logger and otherwise leave the post alone.
export function checkDiagram(text, { log = console.error } = {}) {
  if (text?.length > MERMAID_MAX_TEXT) {
    return {
      message: `Diagram is ${text.length.toLocaleString('en-US')} characters; Mermaid's limit is ${MERMAID_MAX_TEXT.toLocaleString('en-US')}.`,
      line: null,
    };
  }

  let result;
  try {
    result = parseInContext(text);
  } catch (error) {
    logFailure(log, text, error);
    return null;
  }

  if (result?.ok) return null;
  const refusal = refusalFor(result);
  if (refusal) return refusal;
  logFailure(log, text, result || { message: 'parser did not settle synchronously' });
  return null;
}
