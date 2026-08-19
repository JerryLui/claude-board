// Runs every check: `node test/run.mjs`. Each check is also runnable alone.
//
// Every check gets a finite deadline. A check that hangs is a failure, not a
// pending job: removing the interactivity guard from
// bin/mcp.mjs makes the suite block forever on a wait nobody will ever answer, so
// an acceptance-criterion regression presented as a job that never finished
// instead of as a named failure. Each check therefore runs in its own process
// GROUP (detached), so a timeout kills the check *and* every shim and daemon it
// spawned, rather than orphaning wait loops that keep polling.
//
// Checks run CONCURRENTLY, a few at a time. That is safe only because every check
// file already isolates itself: none binds a fixed port (all `listen(0)`), and every
// one that writes anything writes under its own `mkdtempSync` directory. A new check
// that hardcodes a port or a shared path breaks the suite here rather than in itself.
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHECK_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_CHECK_TIMEOUT_MS) || 180_000;

// NO CHECK MAY RAISE A REAL NOTIFICATION. Every check that boots a daemon posts awaited
// rounds into it and then walks away, which is precisely the shape the stranded rule
// (src/stranded.mjs's createStrandedWatch) exists to announce -- so with the shipped
// five-second grace, a run of this suite would put real banners on the reader's
// screen from a dozen different check files, none of which is about notifications at
// all. Pushed out of reach here rather than stubbed in each of them: the checks that DO
// mean to exercise the rule (test/check-notify-round.mjs, test/check-notify-click.mjs,
// test/check-stranded.mjs, test/check-boundary.mjs) set this variable themselves, to a few milliseconds, and
// stand a fake notifier ahead of the real one on PATH while they do. Inherited by every
// spawned check below, and overridable from outside if someone genuinely wants the
// shipped timing.
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS ??= String(24 * 60 * 60 * 1000);

// Capped well below the core count on purpose. The suite's wall clock is pinned by its
// single slowest check (check-install, ~48s of real installer runs and `cc` builds), so
// past a handful of workers there is nothing left to overlap -- measured: 4 jobs and 10
// jobs finish within a second of each other. Staying low leaves headroom for the three
// wall-clock deadlines in check-anchor-perf, which have to hold on a 2-core CI box too.
const JOBS = Number(process.env.CLAUDE_BOARD_JOBS) || Math.min(4, cpus().length);

// Ordered slowest-first, which is what keeps the pool from finishing its short checks
// and then waiting on check-install alone. Worth preserving when adding a check.
const checks = ['check-install.mjs', 'check-http.mjs', 'check-mcp.mjs', 'check-install-payload.mjs', 'check-launcher-menubar.mjs', 'check-notify.mjs', 'check-anchor-perf.mjs', 'check-install-doc.mjs', 'check-menubar-client.mjs', 'check-mermaid-theme.mjs', 'check-pure.mjs', 'check-pomodoro-page.mjs', 'check-index-live.mjs', 'check-launcher-env.mjs', 'check-anchor-robustness.mjs', 'check-mermaid-anchor.mjs', 'check-mermaid-stage.mjs', 'check-prose-check.mjs', 'check-pomodoro.mjs', 'check-comment-mode.mjs', 'check-stage-isolation.mjs', 'check-archive.mjs', 'check-page-board.mjs', 'check-header-condense.mjs', 'check-round-pager.mjs', 'check-stage-lens.mjs', 'check-round-end.mjs', 'check-skill-prose.mjs', 'check-enter.mjs', 'check-anchor-push.mjs', 'check-theme.mjs', 'check-send-guard.mjs', 'check-amend-integrity.mjs', 'check-archive-ids.mjs', 'check-contrast.mjs', 'check-pin-placement.mjs', 'check-anchor-rerender.mjs', 'check-click.mjs', 'check-click-pin.mjs', 'check-parser-parity.mjs', 'check-sample-board.mjs', 'check-demo.mjs', 'check-notify-round.mjs', 'check-attended.mjs', 'check-notify-click.mjs', 'check-stranded.mjs', 'check-notify-cleanup.mjs', 'check-attended-client.mjs', 'check-vendor-digest.mjs', 'check-assets.mjs', 'check-boundary.mjs', 'check-prune.mjs', 'check-launcher-refuses.mjs', 'check-comments.mjs', 'check-harness-globals.mjs', 'check-adr-index.mjs', 'check-artifact-theme.mjs'];

/** Run one check file with a deadline. Resolves `{ code, signal, timedOut, elapsed,
 * output }` — never rejects, so one broken check cannot abort the run.
 *
 * `capture` buys back the one thing running concurrently costs: with the default
 * inherited stdio, four checks printing at once interleave their `ok - ...` lines into
 * a transcript where no line says which file it came from. Captured, each check's
 * output is held and printed in one piece when it finishes. Off by default so a
 * single check run straight from this function still streams live. */
export function runCheck(file, timeoutMs = CHECK_TIMEOUT_MS, { capture = false } = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(process.execPath, [file], {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: true,
    });
    let timedOut = false;
    const chunks = [];
    if (capture) {
      child.stdout.on('data', c => chunks.push(c));
      child.stderr.on('data', c => chunks.push(c));
    }

    const killGroup = () => {
      // Negative pid: the whole process group, i.e. the check and its children.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    // detached means the check no longer shares this process's group, so a
    // terminal Ctrl-C would otherwise leave it running.
    const onSigint = () => { killGroup(); process.exit(130); };
    process.on('SIGINT', onSigint);

    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onSigint);
      resolve({ ...result, elapsed: Date.now() - start, output: Buffer.concat(chunks).toString('utf8') });
    };

    child.on('error', () => done({ code: 1, signal: null, timedOut: false }));
    // 'close', not 'exit': under `capture` the stdio pipes are still delivering when
    // 'exit' fires, and a check's last lines are exactly the ones worth reading. With
    // inherited stdio there are no pipes, so the two fire together.
    child.on('close', (code, signal) => done({ code, signal, timedOut }));
  });
}

async function main() {
  // One SIGINT listener per in-flight check, and node warns past ten of them. The
  // listeners are real and each one is needed; the default ceiling is what's wrong.
  process.setMaxListeners(JOBS + 10);

  const queue = [...checks];
  const failures = [];
  const start = Date.now();

  async function worker() {
    for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
      const file = fileURLToPath(new URL(`./${c}`, import.meta.url));
      const r = await runCheck(file, CHECK_TIMEOUT_MS, { capture: true });
      // One write per check, so a check's own output stays contiguous even while three
      // others are running. Its lines are its own; only this header names the file.
      const verdict = r.timedOut
        ? `FAIL ${c} — timed out after ${Math.round(r.elapsed / 1000)}s (killed, with its child processes)`
        : r.code !== 0
          ? `FAIL ${c}${r.signal ? ` (signal ${r.signal})` : ''}`
          : `--- ${c} (${(r.elapsed / 1000).toFixed(1)}s)`;
      process.stdout.write(`${verdict}\n${r.output}`);
      if (r.timedOut || r.code !== 0) failures.push(c);
    }
  }

  await Promise.all(Array.from({ length: JOBS }, worker));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (failures.length) {
    console.error(`\n${failures.length} of ${checks.length} checks FAILED in ${elapsed}s (${JOBS} at a time): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nall checks ok — ${checks.length} in ${elapsed}s (${JOBS} at a time)`);
}

// Importable (test/check-mcp.mjs exercises runCheck's deadline) without running the
// whole suite recursively.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
