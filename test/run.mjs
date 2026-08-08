// Runs every check in sequence: `node test/run.mjs`. Each check is also runnable alone.
//
// Every check gets a finite deadline. A check that hangs is a failure, not a
// pending job: removing the interactivity guard from
// bin/mcp.mjs makes the suite block forever on a wait nobody will ever answer, so
// an acceptance-criterion regression presented as a job that never finished
// instead of as a named failure. Each check therefore runs in its own process
// GROUP (detached), so a timeout kills the check *and* every shim and daemon it
// spawned, rather than orphaning wait loops that keep polling.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHECK_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_CHECK_TIMEOUT_MS) || 180_000;

const checks = ['check-pure.mjs', 'check-contrast.mjs', 'check-theme.mjs', 'check-http.mjs', 'check-mcp.mjs', 'check-install.mjs', 'check-install-doc.mjs', 'check-install-payload.mjs', 'check-launcher-env.mjs', 'check-prose-check.mjs', 'check-skill-prose.mjs', 'check-click.mjs', 'check-click-pin.mjs', 'check-comment-mode.mjs', 'check-enter.mjs', 'check-round-end.mjs', 'check-round-pager.mjs', 'check-send-guard.mjs', 'check-anchor-rerender.mjs', 'check-mermaid-anchor.mjs', 'check-mermaid-theme.mjs', 'check-archive.mjs', 'check-archive-ids.mjs', 'check-anchor-push.mjs', 'check-amend-integrity.mjs','check-pin-placement.mjs', 'check-parser-parity.mjs', 'check-anchor-robustness.mjs', 'check-anchor-perf.mjs', 'check-stage-isolation.mjs', 'check-stage-lens.mjs', 'check-page-board.mjs', 'check-pomodoro.mjs', 'check-notify.mjs', 'check-pomodoro-page.mjs', 'check-sample-board.mjs'];

/** Run one check file with a deadline. Resolves `{ code, signal, timedOut, elapsed }`
 * — never rejects, so one broken check cannot abort the run. */
export function runCheck(file, timeoutMs = CHECK_TIMEOUT_MS) {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(process.execPath, [file], { stdio: 'inherit', detached: true });
    let timedOut = false;

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

    const done = result => {
      clearTimeout(timer);
      process.off('SIGINT', onSigint);
      resolve({ ...result, elapsed: Date.now() - start });
    };

    child.on('error', () => done({ code: 1, signal: null, timedOut: false }));
    child.on('exit', (code, signal) => done({ code, signal, timedOut }));
  });
}

async function main() {
  let failed = 0;
  for (const c of checks) {
    const file = fileURLToPath(new URL(`./${c}`, import.meta.url));
    const r = await runCheck(file);
    if (r.timedOut) {
      console.error(`FAIL ${c} — timed out after ${Math.round(r.elapsed / 1000)}s (killed, with its child processes)`);
      failed++;
    } else if (r.code !== 0) {
      console.error(`FAIL ${c}${r.signal ? ` (signal ${r.signal})` : ''}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
  console.log('all checks ok');
}

// Importable (test/check-mcp.mjs exercises runCheck's deadline) without running the
// whole suite recursively.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
