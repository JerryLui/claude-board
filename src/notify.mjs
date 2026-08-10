// Native notification, at each pomodoro boundary and at a stranded round
// (SPEC_STRANDED.md, ADR.md entries 56 and 58).
//
// Two ways out, and which one is used is decided by where THIS FILE is running from, not
// by configuration. A daemon running out of claude-board.app/Contents/Resources spawns
// the bundle's own executable in its `--notify` mode (bin/launcher.c, bin/notify.m), and
// the notification then carries claude-board's name and icon, and gets its own row in
// System Settings > Notifications where the reader can set it to Alerts so it stays on
// screen until dismissed. A daemon running out of the clone -- the no-launcher install,
// which has no bundle at all -- falls back to `osascript`, exactly as this file did
// before ADR.md entry 19, and gets Script Editor's name and icon along with it. The
// fallback is not a nicety: it is the only path a degraded install has, and it is also
// the path every check in test/check-notify.mjs takes, since the suite imports this file
// from the clone.
//
// Async only -- execFile, never execFileSync (see QUIRKS.md "execFileSync deadlocks
// against an in-process daemon"). This fires from inside src/pomodoro.mjs's own
// setTimeout callback, on the daemon's one event loop; a synchronous spawn would stall
// every other request behind however long osascript takes to start. Every failure --
// osascript missing, a non-zero exit, Notification Center itself refusing -- is
// swallowed. A reader's OS settings must never be a way to take the clock down, and
// test/check-notify.mjs calls this hundreds of times against a stub: it must never
// throw, and never actually raise a banner.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isCue, NO_CUE } from './cues.mjs';

// A closed-set lookup, not a template. `phase` reaches here as settleBoundary's own
// `boundary.phase` (src/pomodoro.mjs), typed 'work' | 'break' | 'longBreak' -- but that
// is a property of TODAY's one caller, not of this function's contract, and the trust
// boundary is the AppleScript interpreter on the other end of the string built below.
// Every value that can reach that string is therefore a LITERAL out of this table, never
// `phase` itself: an unrecognised phase has no entry and fires nothing, rather than
// falling back to some `` `${phase} started` `` template a future caller could shape.
// Do not add that fallback -- it is the one line that would turn this from "closed set"
// into "free text with extra steps".
//
// Each row carries its own `title` -- "Pomodoro" beside "Board" -- rather than this file
// compiling in one constant the way it used to (bin/launcher.c's MESSAGES mirrors this
// same per-row shape, and the two must agree; see "the launcher knows every phase
// src/notify.mjs will send it" in test/check-notify.mjs). A row is either a fixed
// `message`, or a `format` function of one caller-supplied name plus the `unnamed`
// sentence shown when that name is missing or fails isSafeFolderName below (ADR.md entry
// 56) -- never both.
const MESSAGES = {
  work: { title: 'Pomodoro', message: 'Work interval started' },
  break: { title: 'Pomodoro', message: 'Break started' },
  longBreak: { title: 'Pomodoro', message: 'Long break started' },
  // Not a phase the clock can ever settle on: `test` is what `notifyTest` below fires
  // when the reader ticks Notify, so that "did that do anything?" is answered by a
  // banner rather than by waiting out an interval. It lives in this table with the
  // real phases because that is what the table IS -- the closed set of sentences this
  // file can put on screen -- and adding a row is the sanctioned way to extend it. The
  // rule the header states still holds: no entry, no notification, and never a template.
  test: { title: 'Pomodoro', message: 'Notifications are working' },
  // SPEC_STRANDED.md: the daemon's own banner for a round nobody is watching. The name
  // is whatever src/indexpage.mjs's `folderName` derived for the session -- see
  // notifyRound below for why filtering it is this file's job, not the caller's. No cue
  // of its own (Out of Scope: "a choosable sound for the board banner" -- the cue
  // pickers stay the pomodoro clock's); fire() below gives it the system default sound
  // on the bundle path and stays silent on the osascript fallback (see fire()'s own
  // comment for why the two differ here).
  round: {
    title: 'Board',
    format: folder => `${folder}: a round is waiting.`,
    unnamed: 'A round is waiting.',
  },
};

// Phase -> the settings key holding THAT phase's cue (src/pomodoro.mjs's cueWork/
// cueBreak/cueLongBreak, one row per phase in the settings popover -- ADR.md entry 20).
// A closed table beside MESSAGES above, for the identical
// reason: `phase` selects which settings field to read, it is never interpolated
// into one.
const CUE_KEYS = {
  work: 'cueWork',
  break: 'cueBreak',
  longBreak: 'cueLongBreak',
};

// Unlike `phase` and the two tables above, a cue name is CALLER-SUPPLIED: it started
// life as a JSON value on disk (settings.cueWork et al.), not as a literal this file
// wrote. `isCue` (src/cues.mjs) is what keeps the same "closed set, not free text"
// property true one layer further out -- it is a set built once from
// /System/Library/Sounds and filtered through a conservative name pattern, closed by
// construction the same way MESSAGES is closed by hand. A settings value that is not
// in that set -- absent, `None`, or garbage from a hand-edited pomodoro.json --
// resolves to NO_CUE here, which both call sites below already treat as "cross
// nothing": there is no separate silence branch to forget, exactly as cuePath's own
// comment in cues.mjs describes for the file-path case.
function cueFor(phase, settings) {
  const key = CUE_KEYS[phase];
  const value = key && settings[key];
  return isCue(value) ? value : NO_CUE;
}

// The project-folder argument's own filter, for the 'round' row's format slot above --
// ADR.md entry 56. Shaped exactly like bin/launcher.c's is_safe_cue_name (one leading
// alphanumeric, then any run of alphanumerics, spaces, underscores and hyphens) rather
// than sharing code with it or with cues.mjs's SAFE_NAME: those gate unrelated arguments
// that only happen to want the same character-level rule today. MAX_FOLDER_NAME_LEN must
// match bin/launcher.c's constant of the same name, or the two mirrored paths -- the
// bundle's own filter and this one -- could disagree on which names are safe.
const SAFE_FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const MAX_FOLDER_NAME_LEN = 80;
function isSafeFolderName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < MAX_FOLDER_NAME_LEN
    && SAFE_FOLDER_NAME.test(name);
}

// The click target's filter, mirroring bin/launcher.c's `is_board_url` the same way
// isSafeFolderName mirrors its `is_safe_folder_name` (ADR.md entry 57). The C side is
// the load-bearing one -- it is what stands between argv and LaunchServices, and it
// runs whatever this file sends -- so this is not the boundary; it is what keeps the
// daemon from spending a launcher invocation on a URL the launcher will drop, and what
// makes a caller's mistake visible in a check that never has to compile anything.
//
// The shape both sides accept is exactly what src/server.mjs's boardUrl() builds:
// `http://<loopback host>[:port]/b/<board id>` plus the board page's `#stranded-round`
// sentinel. Notably NOT `/auth/<token>`: a handoff URL carries a credential, and no
// credential goes on a command line at any point (SPEC_STRANDED.md criterion 13) -- the
// browser's own session is what authorizes the page, and a browser holding none gets
// the refusal page that already exists.
//
// Case is where a mirror drifts, so it is spelled out rather than flagged: a whole-
// pattern `/i` made this side accept `HTTP://` and `/B/`, which the C refuses -- 134
// disagreements, every one of them this side being the permissive one. The host is the
// only case-insensitive part, because boardUrl() reflects the `Host` header back
// verbatim and a reviewer may have typed it in any case; the scheme and the `/b/` path
// are this daemon's own bytes, in one case, and tolerance there buys nothing. The host
// is therefore matched loosely here and folded before it is compared, which is exactly
// what is_loopback_host does with tolower().
const BOARD_URL = /^http:\/\/(\[::1\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?\/b\/[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?$/;
const LOOPBACK_SUBDOMAIN = /^[a-z0-9][a-z0-9.-]*\.localhost$/;
const MAX_BOARD_URL_LEN = 200;

/** True iff `url` is a board URL of the daemon listening on `port` -- both halves
 * required, since loopback is shared by every service on the machine and a URL naming
 * another one would have a genuine banner open somebody else's page. `port` is the
 * daemon's own bound port (`server.address().port`), never a header's idea of it. */
export function isBoardUrl(url, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (typeof url !== 'string' || url.length === 0 || url.length >= MAX_BOARD_URL_LEN) return false;
  const m = BOARD_URL.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (!(host === '[::1]' || host === '127.0.0.1' || host === 'localhost' || LOOPBACK_SUBDOMAIN.test(host))) {
    return false;
  }
  // 80 is the port a URL carrying none names, and the Host header carries none on port
  // 80 -- so this compares two numbers rather than a number against "absent".
  return (m[2] === undefined ? 80 : Number(m[2])) === port;
}

// The click-serving process's own backstop, in seconds, mirroring bin/launcher.c's
// CLICK_SECONDS_MAX. Whole seconds because that is what crosses in argv; rounded up, so
// a deadline 400ms away still buys a click rather than a process that exits on arrival.
//
// Exported in milliseconds because the daemon has to reason about the same ceiling from
// the other side: past it, the process below has exited and WITHDRAWN its notification,
// so a board's announced marker no longer stands for anything on screen (src/stranded.mjs's
// `standingBanner`). A wait longer than this ceiling is reachable -- CLAUDE_BOARD_TIMEOUT_MS
// is on the launcher's plist passthrough allowlist -- and without the daemon knowing the
// number, such a wait loses its banner partway through and never gets a replacement.
const MAX_CLICK_SECONDS = 3600;
export const CLICK_LIFETIME_MAX_MS = MAX_CLICK_SECONDS * 1000;

/** `null` means "this banner gets no click", and the caller must then send no URL either
 * -- see `fire` below. Both cases that produce it are the same case: there is no bound
 * to give the process, and an ABSENT argv slot is not "no click", it is the launcher's
 * compiled-in default of forty minutes. A round with an unparseable `awaitDeadline` is
 * awaited forever as far as `roundIsAwaitedOpen` is concerned (it reads `status` and
 * `awaited`, and `closeLapsedAwaitedRounds` can only sweep a deadline it can parse), so
 * omitting the slot bought exactly that: a forty-minute clickable banner for a round with
 * no bound at all. Sending `'1'` instead is not the fix either -- the process withdraws
 * its own notification on the way out, so a one-second lifetime is a banner that vanishes
 * a second after it lands. */
function clickSecondsUntil(deadlineAt) {
  if (!Number.isFinite(deadlineAt)) return null;
  const seconds = Math.ceil((deadlineAt - Date.now()) / 1000);
  if (seconds < 1) return null; // already lapsed: there is nothing left for a click to open
  return String(Math.min(seconds, MAX_CLICK_SECONDS));
}

// The bundle's own executable, or null when this file is not running from inside a
// bundle. Derived from import.meta.url and from nothing else -- never from an environment
// variable, and never from a path the launchd plist could name: this spawns a binary that
// holds the reader's TCC Documents grant, and bin/launcher.c exists precisely so that
// holding that grant is not the same as being able to point it at something. The layout
// it is reading is install.sh's own staging (Contents/Resources/src/notify.mjs, next to
// Contents/MacOS/<CFBundleExecutable>), so the two move together or not at all.
//
// Computed once at import rather than per boundary: it cannot change under a running
// daemon without that daemon being replaced, and a boundary should not pay an existsSync
// to re-learn it.
const APP_EXEC = (() => {
  try {
    const here = fileURLToPath(import.meta.url); // .../Contents/Resources/src/notify.mjs
    const m = here.match(/^(.*\/([^/]+)\.app)\/Contents\/Resources\/src\/notify\.mjs$/);
    if (!m) return null;
    // CFBundleExecutable is the bundle's own name, install.sh's $LABEL -- taken from the
    // .app's filename here rather than hardcoded, so a rename of the bundle cannot leave
    // this pointing at a binary that is not there.
    const exec = `${m[1]}/Contents/MacOS/${m[2]}`;
    return existsSync(exec) ? exec : null;
  } catch {
    return null; // an unreadable path is a fallback to osascript, never a throw.
  }
})();

// Logged once per process, not once per failure: a reader who has Notification Center
// blocked, or who is on a machine with no osascript at all, would otherwise get one
// stderr line per interval boundary for as long as the daemon runs.
let warnedOnce = false;
let warnedClickOnce = false;

/** The execFile callback both paths share. Swallows everything -- see the file header --
 * and names neither binary, because which one ran is decided by APP_EXEC below and the
 * message would otherwise have to be duplicated to stay true. */
function warnOnFailure(err) {
  // A click-serving child is SUPPOSED to be killed: that is how the daemon withdraws a
  // delivered banner when the reviewer comes back (src/stranded.mjs's `terminate`). Node
  // reports that as an error on this callback -- `killed: true, signal: 'SIGTERM'` -- so
  // without this exemption the happy path printed "notifications may not be appearing"
  // on every single return to a board, AND burned the one-shot warning below, so a
  // genuinely broken notifier later in the same run was never reported at all. Nothing
  // else in this file kills a child it spawns, so the exemption costs no coverage.
  if (err && (err.killed || err.signal === 'SIGTERM')) return;
  if (err && !warnedOnce) {
    warnedOnce = true;
    console.error(`notifyBoundary: notification failed, notifications may not be appearing (further failures are not logged): ${err.message}`);
  }
}

/** Quote a string for AppleScript's double-quoted string syntax. Belt-and-suspenders
 * alongside the closed-set table above -- MESSAGES's own values need no escaping today
 * -- so that a later edit widening the table does not quietly become an injection the
 * moment it does. */
function appleScriptQuote(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Fire the native notification for a boundary that just happened. `phase` is the phase
 * that just STARTED (settleBoundary's own `boundary.phase`); `settings` is the pomodoro
 * document's settings, read fresh by the caller on every boundary rather than captured
 * once at daemon boot, so a toggle flipped mid-day takes effect on the very next
 * interval rather than the next restart. Never throws, never awaits the subprocess --
 * see the file header for why. */
export function notifyBoundary(phase, settings) {
  if (!settings || settings.notify === false) return;
  fire(phase, cueFor(phase, settings));
}

/** Fire the daemon's own banner for a round nobody is watching (SPEC_STRANDED.md;
 * CONTEXT.md's Stranded/Banner). `folder` is whatever src/indexpage.mjs's `folderName`
 * derived for the board's session, passed straight through unfiltered -- filtering it is
 * this function's job (isSafeFolderName above), the same division of labour cueFor
 * already has for a cue: the caller hands over what it has, this file decides what is
 * safe to put on screen. `null`/`undefined`, or a name outside the accepted character
 * set, degrades to the row's own unnamed sentence rather than losing the banner (ADR.md
 * entry 56) -- the banner still fires, it just says less.
 *
 * `url` makes the banner clickable (ADR.md entry 57): the board's own URL, built by the
 * daemon from the socket it is actually bound to (`strandedTarget`, src/server.mjs --
 * never `boardUrl`, which reflects the `Host` header) and suffixed with the board page's
 * `#stranded-round` sentinel, which src/ui.mjs resolves to the OLDEST round still
 * waiting. Not `#open-round`, which resolves to the newest open round and belongs to the
 * index's live-row links: the two look alike and mean different things, and only the
 * first satisfies criterion 12. A plain board URL and never a handoff: no credential goes
 * on a command line. Anything isBoardUrl refuses -- and the whole osascript fallback,
 * which has no way to serve a click -- degrades to a banner that cannot be clicked,
 * exactly as the clone install does permanently (criterion 19).
 *
 * `deadlineAt` is the round's own `awaitDeadline` (epoch ms). It becomes the spawned
 * process's self-imposed lifetime, because a wait that lapses fires no event a child
 * could be told about; it is a backstop, not the mechanism. The caller is the owner and
 * kills it earlier -- when the reviewer returns to the board, when the round is
 * answered, and when the daemon itself stops (criterion 15).
 *
 * `port` is the port the daemon ACTUALLY BOUND -- `server.address().port`, never the
 * `Host` header's idea of it. bin/launcher.c's `is_board_url` takes it as a separate
 * argument and refuses any URL whose port disagrees, which is what stops a poisoned
 * `Host` from steering a click: the header can say anything, and the one number the
 * daemon knows from its own socket is what the filter compares it against. It fails
 * closed -- no port, no click -- and says so once per process, because a banner that
 * silently stopped being clickable is exactly the kind of regression that hides.
 *
 * Returns the spawned ChildProcess, or null when nothing was spawned, so the caller has
 * the handle it needs to do exactly that. It is unref'd: a banner must never be the
 * reason a daemon will not shut down. Never throws and never awaits the subprocess,
 * exactly like its siblings. */
export function notifyRound(folder, { url = null, port = null, deadlineAt = null } = {}) {
  return fire('round', NO_CUE, folder, url, port, deadlineAt);
}

/** Withdraw a delivered round banner whose click-serving process THIS daemon did not
 * spawn, by pid. The ordinary withdrawal is `child.kill('SIGTERM')` on the handle
 * `notifyRound` returned; this is the case where that handle is gone but the process is
 * not -- a daemon killed with SIGKILL (`launchctl kickstart -k`, or launchd after
 * `ExitTimeOut`) leaves its children orphaned and its successor with nothing but the pid
 * it recorded on the board. Without this, the reviewer returning could not withdraw a
 * banner still on screen, and criterion 6 would fail for the rest of that wait.
 *
 * Signalling a pid read out of a file is only safe if it is still the process that was
 * written down, and it takes BOTH checks below to establish that. `startedAtMs` is when
 * the record naming this pid was written -- within milliseconds of the spawn.
 *
 *  - the executable must be APP_EXEC, a path derived from `import.meta.url` and never
 *    from argv or the environment. Necessary, and nowhere near sufficient on its own:
 *    every claude-board process shares that exact path, including the launchd job that
 *    SUPERVISES this daemon (install.sh puts the same string in `ProgramArguments`).
 *    SIGTERM to that one is relayed to node, so "the name matches" alone is a way to
 *    take the whole daemon down.
 *  - it must have STARTED when the record says it did. `ps -o etime=` gives elapsed
 *    time, so `now - etime` is the start, and anything that began before the record was
 *    written is by definition not the process the record is about. That is what excludes
 *    the supervisor (running since login), every pomodoro child, and any pid recycled
 *    since. TOLERANCE_MS covers etime's one-second granularity and the gap between spawn
 *    and write; it is deliberately small.
 *
 * ponytail: the confirm-then-signal window is still a TOCTOU -- the process could exit
 * and its pid be reused between `ps` returning and `process.kill`, and a replacement that
 * is ALSO a claude-board click child started within the tolerance would pass both tests.
 * The ceiling is macOS having no pidfd to hold instead; the upgrade path, if it ever
 * matters, is for the child to write a lock file the daemon can prove it owns. The window
 * is milliseconds wide on a path that runs once per return-to-board after an unclean
 * restart, and the caller only reaches it for a banner it believes is still on screen.
 *
 * Async, and every failure swallowed, exactly like everything else in this file. */
const PID_START_TOLERANCE_MS = 5_000;

/** `ps -o etime=` as milliseconds: `[[dd-]hh:]mm:ss`. Null if it is not that shape --
 * which, like every other failure here, means "do not signal". */
export function parseElapsedTime(etime) {
  const m = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(String(etime || ''));
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return ((((Number(dd || 0) * 24) + Number(hh || 0)) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
}

/** Which pids this may signal AT ALL, before anything is asked about them.
 *
 * `process.ppid` is the one that matters and it is not belt-and-braces. The start-time
 * gate below was doing this job: the launchd supervisor shares APP_EXEC exactly
 * (install.sh puts that path in `ProgramArguments`) and its SIGTERM is relayed to node,
 * but it has run since login, so "started before the record was written" excluded it.
 * That stopped being true once a graceful stop began leaving records standing: the
 * SUCCESSOR supervisor starts AFTER `rec.at`, so a record naming a pid this daemon
 * itself killed, plus a pid space that has wrapped, is a SIGTERM to our own supervisor
 * and every blocked `ask` on the machine dying with it. The parent is exactly
 * identifiable and its death is the one that is catastrophic, so it is named outright
 * rather than inferred.
 *
 * Exported because `withdrawClickChild` returns early on a clone install and is
 * unobservable there by construction -- this is the seam that makes the guard checkable. */
export function mayWithdrawPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (pid === process.pid || pid === process.ppid) return false;
  return true;
}

export function withdrawClickChild(pid, startedAtMs) {
  if (!mayWithdrawPid(pid)) return;
  if (!Number.isFinite(startedAtMs)) return; // no idea when it started: do not guess
  // Load-bearing, not incidental: on a clone install `announce` still records the
  // osascript child's pid with an `until` minutes out, and that process exits in
  // milliseconds. Nothing else stops that dead pid being signalled once it has been
  // recycled -- there is no bundle, so there is no click child to withdraw and nothing
  // here has any business sending a signal at all.
  if (!APP_EXEC) return;
  // `etime` FIRST and `comm` last, which is not a style choice: macOS clamps `comm` to
  // MAXCOMLEN (16 bytes) whenever it is not the final column, and says nothing about
  // having done so. Measured on this machine against an APP_EXEC-shaped path:
  //
  //   ps -o comm=,etime=  ->  "/var/folders/vc/ 00:00"      <- truncated, silently
  //   ps -o etime=,comm=  ->  "00:00 /var/folders/.../claude-board"
  //
  // With `comm` first this comparison could never match on any real install (APP_EXEC
  // is 60+ characters), so the whole recorded-pid path was inert: the one case it
  // exists for -- a SIGKILLed daemon leaving an orphan whose banner is still on screen
  // -- withdrew nothing. `etime` is what may not contain a space, and does not; a path
  // may, which is why the split is on the FIRST space and the remainder is the path.
  execFile('ps', ['-o', 'etime=,comm=', '-p', String(pid)], (err, stdout) => {
    if (err) return; // already gone, or no ps: either way there is nothing to withdraw
    const line = String(stdout).trim();
    const cut = line.indexOf(' ');
    if (cut < 0) return;
    if (line.slice(cut + 1).trim() !== APP_EXEC) return; // some other program entirely
    const elapsed = parseElapsedTime(line.slice(0, cut));
    if (elapsed === null) return;
    // Started before the record that names it: a different process wearing its pid.
    if (Date.now() - elapsed < startedAtMs - PID_START_TOLERANCE_MS) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* exited in between; the outcome we wanted */ }
  });
}

/** Fire the one notification whose whole job is to prove notifications arrive, for the
 * reader who has just ticked Notify (src/indexpage.mjs). Deliberately NOT gated on
 * `settings.notify` the way `notifyBoundary` is: the tick that asks for this has not
 * been saved yet, and a test that stays silent until after a Save answers the question
 * backwards. Silent, too -- no cue argument -- because auditioning a SOUND already has
 * its own control beside this one (the cue pickers, `playPreview` in src/server.mjs),
 * and a test banner that also plays something makes it ambiguous which of the two just
 * worked. Never throws and never awaits the subprocess, exactly like its sibling. */
export function notifyTest() {
  fire('test', NO_CUE);
}

/** The spawn both entry points share: the bundle's own executable when this file is
 * running from inside one, `osascript` otherwise (see the file header for why that
 * fallback is load-bearing rather than a nicety). Split out of `notifyBoundary` when
 * `notifyTest` arrived, so the two can never drift into two different ideas of which
 * binary to use or how to quote what it says. `name` is the folder-format row's own
 * caller-supplied argument (notifyRound's `folder`); every other caller leaves it
 * undefined, which isSafeFolderName below always refuses, landing on `unnamed` -- the
 * same outcome a phase with no format row gets by never consulting it at all. `url`,
 * `port` and `deadlineAt` are notifyRound's click target, the port that target must
 * name, and the backstop; they reach the launcher only together, since a lifetime
 * without something to serve would be a process that lives for minutes to do nothing.
 *
 * Returns the spawned ChildProcess (notifyRound's caller kills it), or null when nothing
 * was spawned. */
function fire(phase, cue, name, url = null, port = null, deadlineAt = null) {
  const row = MESSAGES[phase];
  if (!row) return null; // unrecognised phase: no notification, see MESSAGES above.

  const message = row.format ? (isSafeFolderName(name) ? row.format(name) : row.unnamed) : row.message;

  if (APP_EXEC) {
    // `phase` itself crosses here, where every other path in this file passes only
    // literals -- and it is safe for the same reason it is safe on the other side: the
    // launcher's MESSAGES table (bin/launcher.c) is a closed set too, so this argument
    // selects a row rather than supplying text, and an unrecognised value selects
    // nothing. It has also already been checked against this file's own MESSAGES two
    // lines above, so a phase that got here is one both tables know. No shell is
    // involved either way: execFile, not exec.
    //
    // The third argument is the row's OWN format slot -- a cue name for a fixed-message
    // row, the folder for a format row -- appended only when there is a safe one to
    // send, absent entirely rather than an empty string or a sentinel token, so
    // bin/launcher.c's own argv parsing (argc >= 4) is what decides whether one was
    // named at all. cueFor has already reduced whatever settings held to either a name
    // isCue() accepts or NO_CUE; isSafeFolderName below does the identical job for a
    // folder. Either way, what crosses here is never free text.
    const args = ['--notify', phase];
    if (row.format) {
      if (isSafeFolderName(name)) args.push(name);
    } else if (cue !== NO_CUE) {
      args.push(cue);
    }
    // The click target rides in the NEXT slot, so the two are positional and the folder
    // cannot be mistaken for the URL. An unsafe or missing folder is an empty string
    // rather than an omission when a URL follows it: the launcher reads argv by
    // position, and its is_safe_folder_name refuses the empty string exactly as it
    // refuses an absent one -- the unnamed sentence, with the click intact. The
    // placeholder appears ONLY when there is a URL, so a banner with no click still
    // crosses the same argv it always has.
    // The URL, the port and the lifetime cross together or not at all.
    //
    // A URL with no lifetime is not "a click with no deadline", it is a click bounded by
    // the launcher's own compiled-in forty minutes -- a promise this side cannot keep for
    // a round whose deadline it could not read. And a URL with no port is one the
    // launcher's `is_board_url` cannot check against the socket the daemon actually
    // bound, which is the whole defence against a poisoned `Host` steering the click.
    // Either missing means no click: the banner still fires and still says which project
    // wants the reviewer, exactly as the clone install's does permanently (criterion 19).
    const seconds = row.format && isBoardUrl(url, port) ? clickSecondsUntil(deadlineAt) : null;
    if (seconds !== null) {
      if (args.length === 2) args.push('');
      // The port rides beside the URL rather than being folded into it: the launcher has
      // to check one against the other, and a value it derived from the URL itself would
      // be checking that string against nothing.
      args.push(url, String(port), seconds);
    } else if (row.format && url != null && !warnedClickOnce) {
      // Once per process, like warnOnFailure above. The daemon should never hand this a
      // click target this file refuses -- if it does, the banner still fires and simply
      // is not clickable, a degradation nobody would notice until a reviewer clicked and
      // nothing happened. The port is named because a caller with none is the commonest
      // cause, and a lapsed deadline is the other.
      warnedClickOnce = true;
      console.error(`notifyRound: the click target was refused (port given: ${JSON.stringify(port)}), so the banner will not be clickable (further refusals are not logged)`);
    }
    const child = execFile(APP_EXEC, args, warnOnFailure);
    // A click-serving process outlives its own spawn by minutes (ADR.md entry 57), and
    // its stdio pipes are handles of this daemon's event loop. Unref'd, both the child
    // and its pipes, so a pending banner can never be what keeps the daemon from
    // exiting -- the caller still holds the ChildProcess and can still kill it.
    child.unref();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    return child;
  }

  let script = `display notification ${appleScriptQuote(message)} with title ${appleScriptQuote(row.title)}`;
  // Only a resolved cue (cueFor already collapsed "not a cue" and NO_CUE to the same
  // NO_CUE) adds the clause -- crossing into a phase set to None must stay silent, and
  // so must a phase whose settings key is missing or holds something isCue() refuses.
  // appleScriptQuote is belt-and-suspenders here exactly as it already is for MESSAGES
  // above: isCue() is the actual boundary (src/cues.mjs's SAFE_NAME pattern is what
  // makes the closed set closed), so nothing reaches this string that was not already a
  // name macOS ships.
  //
  // ponytail: a format row (currently just 'round') has no cue of its own -- the bundle
  // path plays the system default instead (bin/notify.m's use_default_sound) -- but this
  // fallback stays silent for it rather than adding a `sound name` clause here too. The
  // ceiling: this file has not measured whether AppleScript's `display notification`
  // accepts an empty sound name as "play the default" the way its bundle-side
  // counterpart does, and every other notification/osascript fact in this codebase is
  // stated only after being measured against a real Mac (QUIRKS.md's "macOS
  // notifications and sound" section). Upgrade path: measure it, then add the clause
  // here the same way the cue clause below already works.
  if (!row.format && cue !== NO_CUE) {
    script += ` sound name ${appleScriptQuote(cue)}`;
  }

  // No click on this path, whatever `url` says: `display notification` posts under
  // Script Editor's identity and has no delegate, no category and no process of its own
  // to serve one. ADR.md entry 57 accepts that -- "the clone install keeps a banner it
  // cannot click" -- and criterion 19 asks only that the banner still fires. The
  // returned child is osascript's own, which exits in milliseconds; a caller that kills
  // it finds it already gone, which is the outcome it wanted.
  return execFile('osascript', ['-e', script], warnOnFailure);
}
