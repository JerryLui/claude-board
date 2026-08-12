#!/bin/bash
# Fresh clone -> running service, in one idempotent command. macOS only.
#
# Installs four things, all outside this repo. ADR.md entries 5 and 11 fix that
# boundary: the service, its credential, and the manual for its one tool -- never a
# caller of them.
#
#   1b. ~/Applications/claude-board.app -- launcher bundle, ad-hoc signed under
#       $BUNDLE_ID, with a COPY of bin/daemon.mjs and src/ staged inside the
#       signature. Exists so TCC has an application to attribute the daemon's reads
#       to; without it every read under ~/Documents, ~/Desktop or ~/Downloads is
#       EPERM. Why it forks node rather than exec'ing it: bin/launcher.c. What the
#       grant does and does not widen: SECURITY.md.
#   2.  ~/Library/LaunchAgents/claude-board.plist -- RunAtLoad + KeepAlive, running
#       the daemon through that launcher, or directly on the DEGRADED path.
#   5.  MCP registration: `claude mcp add --scope user`, absolute path into THIS clone.
#   6.  skills/claude-board/SKILL.md -> ~/.claude/skills/claude-board/.
#
# A run that starts under the Claude Code plugin cache installs a fifth thing first:
# a checkout of itself (default ~/Library/Application Support/claude-board-checkout),
# which then plays the clone's part everywhere above -- see "plugin origin" below.
#
# Four invariants an edit here has to preserve:
#
#   IDEMPOTENT. A second run changes nothing and exits 0: no duplicate registration
#   or job, no clobbered logs, no rotated secret, no rebuilt bundle. Reconciliation is
#   unconditional remove-then-add / bootout-then-bootstrap, never a diff against prior
#   state, so a stale registration from another clone path converges the same way a
#   fresh machine does.
#
#   THIS SCRIPT OWNS THE RESTART. New code never restarts the daemon by itself -- the
#   bootout/bootstrap at step 3 is the only thing that takes an update, so a live review
#   survives somebody's save. Do not add WatchPaths: it only starts a job that is not
#   running, KeepAlive guarantees this one always is, so the two fight.
#
#   A LAUNCHD JOB INHERITS NOTHING FROM YOUR SHELL. Every knob the daemon reads from the
#   environment is written into the plist (DEGRADED path) or baked into the launcher
#   (bundle path). Exactly one of the two, never both -- two copies of one decision
#   reads as though rewriting the plist could still move the boundary, when it cannot.
#
#   A REBUILD COSTS THE USER THEIR GRANT. TCC pins a grant to the code signature, so
#   rebuilding the bundle silently revokes Documents access. Anything that changes the
#   bundle's bytes belongs in $LAUNCHER_STAMP; anything that does not must not touch them.
#
# CLAUDE_BOARD_* variables are of two kinds, and the difference is invisible in the code:
# most are TEST SEAMS, defaulting to the real paths so test/check-install.mjs can redirect
# them at a temp dir. CLAUDE_BOARD_HOME, CLAUDE_BOARD_PORT and CLAUDE_BOARD_REF_ROOTS are
# documented configuration (README.md, PROTOCOL.md) and carry forward across reinstalls.
#
# `cc` is the one soft dependency: without it step 1b degrades, the daemon still runs,
# and the install warns rather than fails. The hard ones -- macOS, node >= 22, the
# `claude` CLI -- are refused in preflight, before anything is written.

set -euo pipefail

# --- BEGIN transcript styling (byte-identical in uninstall.sh) ---
# Shared print vocabulary for the two scripts' terminal output: colour gating, the
# palette, step/detail lines, the header, the success banner, footer entries, a spinner
# for a blocking step, and capture-and-surface for third-party command output. Neither
# script sources the other -- this fence is copied byte for byte into both, and
# test/check-install.mjs fails the moment the two drift, the same convention as
# is_throwaway_bundle_path below. Edit here, then paste the whole fence over the copy in
# the other script; do not hand-edit the copy.
#
# COLOUR. On when stdout is a terminal ([ -t 1 ]). Off when NO_COLOR is set (to
# anything, empty included -- it is the variable being SET that means "no colour", not
# its value), when TERM is "dumb", or when stdout is not a terminal.
# CLAUDE_BOARD_COLOR=1 or =always forces it on OVER every one of those -- the seam a
# test needs to reach the coloured path at all, since piped stdio ([ -t 1 ] false) is
# the only stdout a test harness ever gives this script. Decided once, right here;
# nothing below re-checks it mid-run, so a script that changes stdout's terminal-ness
# after sourcing this (nothing here does) would not be noticed.
#
# PALETTE. Six roles, one shell variable each, holding the real escape sequence when
# colour is on and an EMPTY STRING when it is off:
#   CBS_STEP    step name column                     (blue)
#   CBS_BOLD    value / emphasis                      (bold, no colour)
#   CBS_DIM     a path, or other secondary text       (dim)
#   CBS_OK      a ticked step, the success banner     (bold green)
#   CBS_WARN    a warned step                         (bold amber -- ANSI yellow; there
#               is no 8-colour amber, and a 256-colour code would not be as portable)
#   CBS_ERR     a failed step                         (bold red)
#   CBS_RESET   closes any of the above
# This is the WHOLE colour mechanism: every function below is built only from these
# seven variables, so with colour off they contribute nothing, and stripping ANSI from
# a coloured run reproduces the piped run line for line by construction -- no print site
# anywhere has to remember to special-case plain output.
#
# STEP LINES. cbs_step_ok / cbs_step_warn / cbs_step_fail STEP RESULT [PATH]. Two
# leading spaces, the glyph (unconditionally unicode -- macOS ships a UTF-8 locale, so
# ✓ ! ✗ are used outright, no ASCII fallback), the step name in a fixed-width column,
# the result text, then PATH -- when given -- dimmed at the end. cbs_step_ok writes to
# STDOUT. cbs_step_warn and cbs_step_fail write to STDERR, and so does every
# cbs_detail call beneath them: stdout carries only the transcript of a run that is
# going well, nothing else. cbs_detail TEXT prints one indented, dimmed line beneath a
# warned or failed step -- call it once per line of detail, right after the step line
# it belongs to.
#
# HEADER / BANNER / FOOTER, all to stdout. cbs_header NAME [PORT] prints the one-line
# opener (PORT omitted prints just the name). cbs_success MESSAGE prints the closing
# banner. cbs_footer_entry LABEL VALUE prints one footer line under it.
#
# SPINNER. cbs_spinner_start LABEL, then cbs_spinner_stop right before the step
# resolves. A no-op pair -- nothing started, nothing printed -- unless stdout is a
# terminal, TERM is not "dumb" (which genuinely cannot reposition a cursor, so there is
# nothing safe for a spinner to do there), and CLAUDE_BOARD_VERBOSE is not set; a piped
# run (every run this repo's test suite makes) never launches the background process at
# all. cbs_spinner_stop's own erase is colour-free BY CONSTRUCTION, not by checking
# colour state: a bare carriage return plus a fixed run of plain spaces, never an ANSI
# escape, because colour being off is not the same claim as "nothing was drawn" -- the
# spinner still ran, in plain text, and still has to be erased. The caller must call
# cbs_spinner_stop on EVERY path out of the blocking step, success and failure alike,
# before printing the real step line that is meant to overwrite the spinner's last
# line -- this fence installs no EXIT trap of its own, on purpose, so it can neither
# clobber nor be clobbered by a trap the calling script sets for something else (see
# install.sh's own EXIT trap on $LAUNCHER_BUILD_DIR).
#
# CAPTURE-AND-SURFACE. cbs_run_captured CMD [ARGS...] runs a third-party command with
# its stdout and stderr merged and captured into CBS_LAST_CAPTURE, printing nothing
# itself, and returns the command's own exit status without ever tripping `set -e` --
# the caller is expected to branch on a failure, not have the script die on one.
# Under CLAUDE_BOARD_VERBOSE it instead lets the command through live, straight to
# this script's own stdout/stderr, and leaves CBS_LAST_CAPTURE empty. cbs_print_captured
# prints CBS_LAST_CAPTURE back out as cbs_detail lines, for the step whose command
# just failed; call it only on the branch that decided to. A run that captured nothing
# prints nothing.
#
# VERBOSE. CLAUDE_BOARD_VERBOSE, read from the environment and actually normalised here
# to "0" or "1" -- unset or exactly "0" is off, any other non-empty value (CLAUDE_BOARD_
# VERBOSE=true included) is on, so a truthy-looking value never silently reads as off at
# one of the `= "1"` comparisons below. install.sh additionally parses its own --verbose
# flag and sets CLAUDE_BOARD_VERBOSE=1 from it, before calling anything below that reads
# this variable (the spinner, cbs_run_captured); uninstall.sh takes no flags of its own,
# so for its copy of this fence CLAUDE_BOARD_VERBOSE is exactly what the environment,
# normalised, says.
if [ -n "${CLAUDE_BOARD_VERBOSE:-}" ] && [ "$CLAUDE_BOARD_VERBOSE" != "0" ]; then
  CLAUDE_BOARD_VERBOSE=1
else
  CLAUDE_BOARD_VERBOSE=0
fi

if [ -n "${CLAUDE_BOARD_COLOR:-}" ] && { [ "$CLAUDE_BOARD_COLOR" = "1" ] || [ "$CLAUDE_BOARD_COLOR" = "always" ]; }; then
  _CBS_COLOR_ON=1
elif [ -n "${NO_COLOR+set}" ] || [ "${TERM:-}" = "dumb" ] || [ ! -t 1 ]; then
  _CBS_COLOR_ON=0
else
  _CBS_COLOR_ON=1
fi

if [ "$_CBS_COLOR_ON" -eq 1 ]; then
  CBS_STEP=$'\033[34m';   CBS_BOLD=$'\033[1m';    CBS_DIM=$'\033[2m'
  CBS_OK=$'\033[1;32m';   CBS_WARN=$'\033[1;33m'; CBS_ERR=$'\033[1;31m'
  CBS_RESET=$'\033[0m'
else
  CBS_STEP='';  CBS_BOLD=''; CBS_DIM=''
  CBS_OK='';    CBS_WARN=''; CBS_ERR=''
  CBS_RESET=''
fi

# Internal formatter behind the three step-status functions -- not part of the
# documented API above. Padding is computed on the PLAIN text before any colour is
# wrapped around it: an escape sequence counts as characters to printf's field width,
# so padding an already-coloured string would throw the column out of alignment the
# moment colour is on. 11 and 24 are column widths chosen to match the rendered
# checklist this fence implements, not anything derived at runtime.
cbs__step_line() {
  # $1=glyph  $2=glyph's colour var  $3=step  $4=result  $5=path (optional)
  _cbs_step_field="$(printf '%-11s' "$3")"
  if [ -n "${5:-}" ]; then
    _cbs_result_field="$(printf '%-24s' "$4")"
    printf '  %s%s%s  %s%s%s%s%s%s%s\n' \
      "$2" "$1" "$CBS_RESET" \
      "$CBS_STEP" "$_cbs_step_field" "$CBS_RESET" \
      "$_cbs_result_field" \
      "$CBS_DIM" "$5" "$CBS_RESET"
  else
    printf '  %s%s%s  %s%s%s%s\n' \
      "$2" "$1" "$CBS_RESET" \
      "$CBS_STEP" "$_cbs_step_field" "$CBS_RESET" \
      "$4"
  fi
}

cbs_step_ok()   { cbs__step_line '✓' "$CBS_OK"   "$1" "$2" "${3:-}"; }
cbs_step_warn() { cbs__step_line '!' "$CBS_WARN" "$1" "$2" "${3:-}" >&2; }
cbs_step_fail() { cbs__step_line '✗' "$CBS_ERR"  "$1" "$2" "${3:-}" >&2; }

cbs_detail() {
  printf '        %s%s%s\n' "$CBS_DIM" "$1" "$CBS_RESET" >&2
}

cbs_header() {
  if [ -n "${2:-}" ]; then
    _cbs_name_field="$(printf '%-48s' "$1")"
    printf '  %s%s%s%sport%s %s%s%s\n' \
      "$CBS_BOLD" "$_cbs_name_field" "$CBS_RESET" \
      "$CBS_DIM" "$CBS_RESET" \
      "$CBS_BOLD" "$2" "$CBS_RESET"
  else
    printf '  %s%s%s\n' "$CBS_BOLD" "$1" "$CBS_RESET"
  fi
}

cbs_success() {
  printf '  %s●  %s%s\n' "$CBS_OK" "$1" "$CBS_RESET"
}

cbs_footer_entry() {
  _cbs_label_field="$(printf '%-6s' "$1")"
  printf '     %s%s%s  %s\n' "$CBS_DIM" "$_cbs_label_field" "$CBS_RESET" "$2"
}

# Fixed width of the spinner's own line: 2 leading spaces, the 11-wide step column, a
# 2-space gap, a 4-digit elapsed field and "s" -- 2+11+2+4+1. Fixed, not measured, so
# cbs_spinner_stop can erase it with a matching run of plain spaces (see below) instead
# of an ANSI escape; 4 digits covers up to 9999 seconds, far past any real blocking step
# this repo has (the longest, the health wait, gives up within a few minutes).
CBS_SPINNER_LINE_WIDTH=20

# Started right before a blocking step, stopped right after -- see the API comment
# above for the caller's obligation to always stop it. CBS_SPINNER_PID empty means
# "nothing running", both before the first start and after every stop, so
# cbs_spinner_stop is always safe to call even when no spinner was ever started.
CBS_SPINNER_PID=""

cbs_spinner_start() {
  CBS_SPINNER_PID=""
  [ -t 1 ] || return 0
  # TERM=dumb cannot reposition its cursor at all, so there is no safe way for a spinner
  # to update in place -- skipped outright, not just left uncoloured. This is the one
  # place the spinner checks TERM directly rather than going through the colour toggle:
  # colour being off is a separate claim from "cannot redraw a line", and a spinner is
  # still wanted on every OTHER terminal regardless of colour.
  [ "${TERM:-}" = "dumb" ] && return 0
  [ "$CLAUDE_BOARD_VERBOSE" = "1" ] && return 0
  _cbs_spinner_field="$(printf '%-11s' "$1")"
  # Subshell, so $_cbs_start and $_cbs_elapsed never leak into the caller's shell.
  # Backgrounded and left running -- deliberately not `wait`ed here, since the whole
  # point is that the caller's own blocking command runs concurrently with this. The
  # elapsed field is fixed-width (%4d) so every line this prints is exactly
  # CBS_SPINNER_LINE_WIDTH characters wide, colour codes aside -- see cbs_spinner_stop.
  ( _cbs_start="$(date +%s)"
    while :; do
      _cbs_elapsed=$(( $(date +%s) - _cbs_start ))
      printf '\r  %s%s%s  %4ds' "$CBS_STEP" "$_cbs_spinner_field" "$CBS_RESET" "$_cbs_elapsed"
      sleep 1
    done
  ) &
  CBS_SPINNER_PID=$!
}

cbs_spinner_stop() {
  [ -n "$CBS_SPINNER_PID" ] || return 0
  kill "$CBS_SPINNER_PID" 2>/dev/null || true
  wait "$CBS_SPINNER_PID" 2>/dev/null || true
  CBS_SPINNER_PID=""
  # Erases the spinner's last line WITHOUT an ANSI escape: a run with colour off has to
  # carry zero escape bytes on stdout, and \033[K is one even though it carries no
  # colour of its own -- the spinner runs (in plain text) whenever stdout is a
  # terminal, independently of whether colour is on, so its erase cannot lean on colour
  # being on to justify using an escape. A bare \r returns to column 0,
  # CBS_SPINNER_LINE_WIDTH plain spaces overwrite whatever the spinner drew, then a
  # second bare \r returns to column 0 again so the real step line that prints next
  # starts clean.
  printf '\r%*s\r' "$CBS_SPINNER_LINE_WIDTH" ''
}

# CBS_LAST_CAPTURE is a plain script variable, not function-local (this fence follows
# the rest of this script in never using `local` -- see is_throwaway_bundle_path's
# _tmproot below for the same convention -- partly for style and partly because
# `local x=$(cmd)` masks a failing $(cmd)'s exit status from `set -e`, which the `||`
# idiom below is written specifically to preserve instead).
CBS_LAST_CAPTURE=""

cbs_run_captured() {
  _cbs_status=0
  if [ "$CLAUDE_BOARD_VERBOSE" = "1" ]; then
    CBS_LAST_CAPTURE=""
    "$@" || _cbs_status=$?
    return "$_cbs_status"
  fi
  CBS_LAST_CAPTURE="$("$@" 2>&1)" || _cbs_status=$?
  return "$_cbs_status"
}

cbs_print_captured() {
  [ -n "$CBS_LAST_CAPTURE" ] || return 0
  while IFS= read -r _cbs_line; do
    cbs_detail "$_cbs_line"
  done <<< "$CBS_LAST_CAPTURE"
}
# --- END transcript styling ---

# --verbose: this script's own flag, not the fence's -- restores the live third-party
# output cbs_run_captured otherwise swallows, the full config header, and the standing
# macOS prose in full, and (as a side effect of the fence's own check) suppresses the
# spinner. Parsed once, here, before anything below reads CLAUDE_BOARD_VERBOSE.
# Set only by the exec at the end of the plugin-origin relocation below -- argv rather
# than an env var, and assigned unconditionally here first, so nothing an environment
# exports can pre-arm it (a `:-` default would inherit an exported value).
INSTALL_RELOCATED=0
for _cbs_install_arg in "$@"; do
  case "$_cbs_install_arg" in
    --verbose) CLAUDE_BOARD_VERBOSE=1 ;;
    --relocated) INSTALL_RELOCATED=1 ;;
  esac
done

# --- transcript helpers -------------------------------------------------------
# Built on the fence's palette, not part of it -- these are specific to this script's own
# checklist, so they live here rather than in the shared block. Defined early: the config
# header below is this script's first output and already needs cbs_config_line.

# Cosmetic only: shortens a path under $HOME to ~/... the way the chosen rendering does.
# Never used for anything but a printed line -- every path this script actually acts on
# stays the real, unabbreviated value.
display_path() {
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# One config-header line: a dim label, the value, and an optional dim "[FROM]" tag. Used
# both by the condensed header (only a value that differs from a default earns a line)
# and, under --verbose, by the full one.
cbs_config_line() {  # LABEL VALUE [FROM]
  if [ -n "${3:-}" ]; then
    printf '     %s%s:%s  %s %s[%s]%s\n' "$CBS_DIM" "$1" "$CBS_RESET" "$2" "$CBS_DIM" "$3" "$CBS_RESET"
  else
    printf '     %s%s:%s  %s\n' "$CBS_DIM" "$1" "$CBS_RESET" "$2"
  fi
}

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_PATH="$REPO_DIR/bin/daemon.mjs"
MCP_PATH="$REPO_DIR/bin/mcp.mjs"

MCP_CMD="${CLAUDE_BOARD_MCP_CMD:-claude}"
LAUNCHCTL_CMD="${CLAUDE_BOARD_LAUNCHCTL_CMD:-launchctl}"
PLUTIL_CMD="${CLAUDE_BOARD_PLUTIL_CMD:-plutil}"
LAUNCH_AGENTS_DIR="${CLAUDE_BOARD_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${CLAUDE_BOARD_LOG_DIR:-$HOME/Library/Logs/claude-board}"
SECRET_FILE="${CLAUDE_BOARD_SECRET_FILE:-$HOME/.config/claude-board/secret}"
APP_DIR="${CLAUDE_BOARD_APP_DIR:-$HOME/Applications}"
CC_CMD="${CLAUDE_BOARD_CC:-cc}"
CODESIGN_CMD="${CLAUDE_BOARD_CODESIGN:-codesign}"
SKILLS_DIR="${CLAUDE_BOARD_SKILLS_DIR:-$HOME/.claude/skills}"
SKILL_SRC="$REPO_DIR/skills/claude-board/SKILL.md"
SKILL_DEST_DIR="$SKILLS_DIR/claude-board"

# Needed before the roots/store/port resolution just below, which now carries a previous
# choice forward by reading it back from here rather than from the plist -- see that
# resolution's comments and "Carry-forward across reinstalls" further down. The
# directory itself is created (0700) in step 0; these are just its filenames, alongside
# the secret and the launcher build stamp it already holds. Three records, one per
# install-time choice that must survive a reinstall run from a shell that never mentions
# it: the reference roots, the store, and the port (the last added because reverting a
# custom port to the default is a bind failure and a KeepAlive throttle loop).
# uninstall.sh names all three in its "left in place on purpose" summary.
SECRET_DIR="$(dirname "$SECRET_FILE")"
REF_ROOTS_RECORD_FILE="$SECRET_DIR/ref_roots"
BOARD_HOME_RECORD_FILE="$SECRET_DIR/board_home"
PORT_RECORD_FILE="$SECRET_DIR/port"
# `/file/` and its allowlist are gone (ADR.md entry 38); this is only the old record's
# filename, kept so the cleanup below can name and delete whatever an older install left.
SERVE_ROOTS_RECORD_FILE="$SECRET_DIR/serve_roots"

# The launcher's compiled-in PATH (bin/launcher.c, launcher_paths.h below): the daemon
# shells out to `osascript` and `open`, and an inherited PATH would hand a TCC-granted
# process to whatever the plist -- world-readable, user-writable -- puts first on it. No
# CLAUDE_BOARD_* override for this one: unlike the roots and the store, there is no
# legitimate reason for an operator to widen it, only ways to weaken it.
LAUNCHER_CHILD_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# TCC records a grant against the bundle identifier and the code signature, so this
# string is the durable name of the thing the user ticks in System Settings. It is
# derived from the repository, not from the clone path or the package version — both of
# which move — because a machine that has already been granted Documents access must not
# be asked for it again by an install that merely landed new JavaScript.
BUNDLE_ID="io.github.jerrylui.claude-board"

# The plist's Label MUST be exactly this: the shim's unreachable-daemon
# message (bin/mcp.mjs) tells users `launchctl kickstart -k
# gui/$(id -u)/claude-board`, and that command only works if the label
# matches.
LABEL="claude-board"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
OUT_LOG="$LOG_DIR/daemon.out.log"
ERR_LOG="$LOG_DIR/daemon.err.log"
LAUNCHER_SRC="$REPO_DIR/bin/launcher.c"
# Compiled into the same binary as launcher.c, because macOS gives a notification the
# identity of the bundle's CFBundleExecutable and refuses it to anything else in the
# bundle (bin/notify.m's header). ADR.md entry 19.
LAUNCHER_NOTIFY_SRC="$REPO_DIR/bin/notify.m"
# The third half of the same binary: the `--menubar` mode the launcher forks beside node
# (ADR 72). In the same executable rather than beside it for the same reason notify.m is --
# one bundle, one signature, one LaunchServices record -- and Objective-C because the
# status item is AppKit.
LAUNCHER_MENUBAR_SRC="$REPO_DIR/bin/menubar.m"
# The bundle's icon, and therefore the icon on every pomodoro notification. Drawn from
# the same bars and colours as the board mark in src/styles.mjs (the one the favicon
# draws), but NOT that mark's raw 32x32 SVG: an app icon is redrawn to the macOS grid,
# the body scaled to roughly 819/1024 (~4/5) of the 1024
# canvas, centered on transparency, and rounded to roughly the standard macOS corner
# radius (184.32px, 0.18 of the canvas). Neither the padding nor the radius is visible on
# macOS 26, which refits and masks a legacy icns itself whatever shape the artwork is
# (QUIRKS.md measured a sharp full-bleed square coming back as a clean tile); both are
# there for older macOS and for any surface that pads without masking. Regenerated by:
#   rsvg-convert -w N -h N mark-grid.svg -o icon_NxN.png   (N = 16,32,64,128,256,512,1024)
#   iconutil -c icns -o bin/claude-board.icns claude-board.iconset
# Checked in rather than generated here: rsvg-convert is a homebrew package, and an
# install must not need one. Treated as optional below for the same reason a missing C
# compiler is — an unbrandable bundle is worth more than no bundle. Whatever redraws it
# next must keep every size iconutil put in this icns, or an install that already has one
# staged silently drops a size the old one carried.
LAUNCHER_ICON_SRC="$REPO_DIR/bin/${LABEL}.icns"
APP_PATH="$APP_DIR/${LABEL}.app"
APP_EXEC="$APP_PATH/Contents/MacOS/${LABEL}"
# Where the daemon's own code lands inside the bundle (step 1b below stages bin/daemon.mjs
# and all of src/ there, preserving daemon.mjs's own `../src/server.mjs` relative import),
# and therefore the path baked into the launcher as CLAUDE_BOARD_DAEMON once a bundle is in
# use. Deliberately the INSTALLED path ($APP_PATH), not the staged one ($LAUNCHER_BUILD_DIR,
# defined below) — the launcher runs from ~/Applications, never from the build directory,
# which is removed the moment this script exits.
BUNDLED_DAEMON_PATH="$APP_PATH/Contents/Resources/bin/daemon.mjs"

# --- preflight: the ways this machine cannot run the service at all -----------
# Everything past this section writes, builds, signs or registers. A refusal that belongs
# to the MACHINE rather than to the install goes here, so it costs nothing and names its
# own cause; left to surface later, each of these arrives under a false name (a missing
# node fails the health gate as "the daemon is NOT running", a missing `claude` CLI fails
# at step 5 with the plist written and the registration this repo does not own torn down).
#
# `cc` stays out of preflight on purpose: without it step 1b degrades and the daemon still
# runs, so it is a warning, not a refusal.

if [ ! -f "$DAEMON_PATH" ] || [ ! -f "$MCP_PATH" ] || [ ! -f "$LAUNCHER_SRC" ] || [ ! -d "$REPO_DIR/src" ]; then
  echo "error: bin/daemon.mjs, bin/mcp.mjs, bin/launcher.c or src/ not found under $REPO_DIR — run this script from a claude-board clone" >&2
  exit 1
fi
# src/ is required on the DEGRADED path too: bin/daemon.mjs imports ../src/server.mjs.

# No degraded mode on another kernel: launchd agent, TCC-attributed bundle,
# UserNotifications.
KERNEL="$(uname -s 2>/dev/null || true)"
if [ "$KERNEL" != "Darwin" ]; then
  echo "error: claude-board installs on macOS only — this host reports '${KERNEL:-an unknown kernel}'." >&2
  echo "       The service is a launchd agent with a TCC-attributed app bundle; there is no" >&2
  echo "       equivalent to fall back to here." >&2
  exit 1
fi

# Empty $HOME roots the whole install at "/", and it is baked into the launcher as
# CLAUDE_BOARD_HOME_DIR.
if [ -z "${HOME:-}" ]; then
  echo "error: HOME is empty — every path this script writes is derived from it." >&2
  exit 1
fi

# --- plugin origin: relocate to a checkout that outlives the cache -------------
# Claude Code delivers a plugin as a versioned cache directory and sweeps the old
# version ~14 days after an update, so nothing durable may point into it -- and this
# script bakes REPO_DIR into durable things: the MCP registration, a degraded plist's
# daemon path, the launcher header's CLAUDE_BOARD_REPO_ROOT (what recoveryCommand
# prints as the path to bin/authorize.mjs). A run that finds itself inside the cache
# therefore copies what the install needs to a stable checkout and re-execs from
# there, and the rest of this script never learns the cache existed. A clone is the
# user's and is never relocated; the checkout is this script's own, which the marker
# file below proves -- every rm -rf against the checkout, here and in uninstall.sh,
# requires the marker, so a real clone parked at this path can never be deleted as
# if it were ours.
#
# Placed after the three machine refusals above so nothing destructive runs on a
# tree, or a machine, the install would refuse anyway. The trailing-slash trims are
# load-bearing: with a slash, the tmp path lands INSIDE the old checkout (deleted
# with it), and the cache-root pattern never matches (relocation silently skipped).
CHECKOUT_MARKER=".claude-board-checkout"
PLUGIN_CACHE_ROOT="${CLAUDE_BOARD_PLUGIN_CACHE_ROOT:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins}"
PLUGIN_CACHE_ROOT="${PLUGIN_CACHE_ROOT%/}"
CHECKOUT_DIR="${CLAUDE_BOARD_CHECKOUT_DIR:-$HOME/Library/Application Support/claude-board-checkout}"
CHECKOUT_DIR="${CHECKOUT_DIR%/}"
# Both sides compared in logical AND physical form: REPO_DIR is bash's logical pwd,
# ~/.claude is routinely a symlink into a dotfiles repo, and CLAUDE_CONFIG_DIR
# relocates it outright. A missed match fails OPEN -- no relocation, and the cache
# path is baked into everything -- so the match is deliberately generous.
REPO_DIR_PHYS="$(cd "$REPO_DIR" && pwd -P)"
PLUGIN_CACHE_ROOT_PHYS="$(cd "$PLUGIN_CACHE_ROOT" 2>/dev/null && pwd -P || printf '%s' "$PLUGIN_CACHE_ROOT")"
PLUGIN_ORIGIN=0
case "$REPO_DIR/" in
  "$PLUGIN_CACHE_ROOT/"*|"$PLUGIN_CACHE_ROOT_PHYS/"*) PLUGIN_ORIGIN=1 ;;
esac
case "$REPO_DIR_PHYS/" in
  "$PLUGIN_CACHE_ROOT/"*|"$PLUGIN_CACHE_ROOT_PHYS/"*) PLUGIN_ORIGIN=1 ;;
esac
if [ "$PLUGIN_ORIGIN" -eq 1 ]; then
  # Refused BEFORE anything is copied or deleted, not discovered on the second pass:
  # a checkout under the cache root would re-exec forever. --relocated backstops the
  # same loop if a future edit breaks this check.
  case "$CHECKOUT_DIR/" in
    "$PLUGIN_CACHE_ROOT/"*|"$PLUGIN_CACHE_ROOT_PHYS/"*)
      echo "error: CLAUDE_BOARD_CHECKOUT_DIR ($CHECKOUT_DIR) resolves under the plugin cache ($PLUGIN_CACHE_ROOT)" >&2
      echo "       set CLAUDE_BOARD_CHECKOUT_DIR to a directory outside the cache" >&2
      exit 1 ;;
  esac
  if [ "$INSTALL_RELOCATED" = "1" ]; then
    echo "error: the relocated install ($REPO_DIR) still resolves under the plugin cache ($PLUGIN_CACHE_ROOT)" >&2
    echo "       set CLAUDE_BOARD_CHECKOUT_DIR to a directory outside the cache" >&2
    exit 1
  fi
  if [ -d "$CHECKOUT_DIR" ] && [ ! -f "$CHECKOUT_DIR/$CHECKOUT_MARKER" ]; then
    echo "error: $CHECKOUT_DIR exists and is not a claude-board checkout (no $CHECKOUT_MARKER file)" >&2
    echo "       move it aside, or set CLAUDE_BOARD_CHECKOUT_DIR elsewhere" >&2
    exit 1
  fi
  cbs_step_ok "plugin" "relocating" "$(display_path "$CHECKOUT_DIR")"
  CHECKOUT_TMP="$CHECKOUT_DIR.tmp.$$"
  rm -rf "$CHECKOUT_TMP"
  # Tmp litter from a crashed earlier run, swept only when it carries the marker --
  # the same proof-of-ownership every other deletion here demands.
  for _stale_tmp in "$CHECKOUT_DIR".tmp.*; do
    if [ -f "$_stale_tmp/$CHECKOUT_MARKER" ]; then rm -rf "$_stale_tmp"; fi
  done
  mkdir -p "$(dirname "$CHECKOUT_DIR")"
  mkdir -p "$CHECKOUT_TMP"
  trap 'rm -rf "$CHECKOUT_TMP"' EXIT
  # The set the install actually needs, entry by entry, never the whole cache: for a
  # local-path marketplace source the cache is a working-directory copy, gitignored
  # files included, and none of that belongs in a durable second copy. Per-entry cp
  # into a directory we made also keeps a symlinked cache dir from turning the
  # checkout itself into a symlink back into the cache.
  for _entry in install.sh uninstall.sh package.json LICENSE bin src skills; do
    cp -R "$REPO_DIR/$_entry" "$CHECKOUT_TMP/$_entry"
  done
  # Marker before the chmod, so it gets the same owner-only mode as everything else.
  : > "$CHECKOUT_TMP/$CHECKOUT_MARKER"
  chmod -R u+w,go-rwx "$CHECKOUT_TMP"
  # Swap by rename, old tree aside first: the failure between the two renames costs a
  # moment of no checkout, never a good checkout replaced by nothing.
  CHECKOUT_OLD=""
  if [ -d "$CHECKOUT_DIR" ]; then
    CHECKOUT_OLD="$CHECKOUT_DIR.old.$$"
    mv "$CHECKOUT_DIR" "$CHECKOUT_OLD"
  fi
  if ! mv "$CHECKOUT_TMP" "$CHECKOUT_DIR"; then
    if [ -n "$CHECKOUT_OLD" ]; then mv "$CHECKOUT_OLD" "$CHECKOUT_DIR"; fi
    echo "error: could not move the staged checkout into place at $CHECKOUT_DIR" >&2
    exit 1
  fi
  if [ -n "$CHECKOUT_OLD" ]; then rm -rf "$CHECKOUT_OLD"; fi
  trap - EXIT
  exec bash "$CHECKOUT_DIR/install.sh" --relocated "$@"
fi

# This path is baked into the signed launcher and into the MCP registration, so it has to
# outlive the next `node` upgrade. Two shapes fail that bar, and the case list below
# matches both: a VERSIONED directory (~/.nvm/versions/node/v24.18.0/bin) that the upgrade
# deletes, and a SHIM directory (mise/shims, nodenv/shims, fnm multishell) that dispatches
# through the version manager's config at call time -- which launchd runs without. Either
# way launchd points at nothing and every session reports "daemon is not reachable"; once a
# bundle is in use, rewriting the plist cannot fix it, because the path is compiled in.
#
# Prefer a stable interpreter, fall back to the version-managed one, and print whichever
# happened. CLAUDE_BOARD_NODE overrides.
NODE_BIN="${CLAUDE_BOARD_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
  case "$NODE_BIN" in
    */.nvm/*|*/.volta/*|*/.asdf/*|*/n/versions/*|\
    */.fnm/*|*/fnm/node-versions/*|*/fnm_multishells/*|\
    */mise/installs/*|*/mise/shims/*|*/rtx/installs/*|*/rtx/shims/*|\
    */.nodenv/*|*/nodenv/versions/*|*/nodenv/shims/*)
      for stable in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
        if [ -x "$stable" ]; then
          cbs_step_warn "node" "node on PATH is version-managed; using $stable"
          cbs_detail "found $NODE_BIN"
          cbs_detail "set CLAUDE_BOARD_NODE to override"
          NODE_BIN="$stable"
          break
        fi
      done
      if [ "$NODE_BIN" = "$(command -v node || true)" ]; then
        cbs_step_warn "node" "only a version-managed node was found ($NODE_BIN)"
        cbs_detail "breaks the next time that version is removed"
        cbs_detail "install node system-wide, or set CLAUDE_BOARD_NODE, then re-run"
      fi
      ;;
  esac
fi
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "error: node interpreter '$NODE_BIN' is not executable" >&2
  exit 1
fi

# Kept in step with package.json's `engines.node`; test/check-install.mjs fails on drift.
# Checked here because an old node fails later as a health-gate timeout naming the wrong
# cause -- the daemon cannot parse its own source.
MIN_NODE_MAJOR=22
NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "error: could not read a version from '$NODE_BIN --version' (got: ${NODE_VERSION:-nothing})." >&2
    echo "       claude-board needs node ${MIN_NODE_MAJOR} or newer." >&2
    exit 1
    ;;
esac
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  echo "error: node $NODE_VERSION at $NODE_BIN is too old — claude-board needs node ${MIN_NODE_MAJOR} or newer." >&2
  echo "       Install a newer node (or point CLAUDE_BOARD_NODE at one) and re-run this script." >&2
  exit 1
fi

# Without the Claude Code CLI there is nothing to register with, and a daemon no session
# can reach is not an install.
if ! command -v "$MCP_CMD" >/dev/null 2>&1; then
  echo "error: the Claude Code CLI ('$MCP_CMD') was not found." >&2
  echo "       claude-board registers its MCP server with it (step 5 below), so an install" >&2
  echo "       without it would leave a running daemon no session can reach. Install Claude" >&2
  echo "       Code — or set CLAUDE_BOARD_MCP_CMD to its path — and re-run this script." >&2
  exit 1
fi

# Empty is refused rather than treated as a choice: it bakes CLAUDE_BOARD_STORE_DIR "" into
# the signed launcher and leaves a zero-byte carry-forward record that repeats it on every
# later reinstall. Unset the variable for the default store.
if [ -n "${CLAUDE_BOARD_HOME+set}" ] && [ -z "$CLAUDE_BOARD_HOME" ]; then
  echo "error: CLAUDE_BOARD_HOME is set but empty — unset it to use the default store" >&2
  echo "       (~/Library/Application Support/claude-board), or give it a real path." >&2
  exit 1
fi

# CARRY-FORWARD, the shape all three install-time choices below share (port, reference
# roots, store). Each is resolved by the same precedence -- explicit variable, then the
# record file next to the secret, then a one-time migration out of the plist an older
# install wrote, then the default -- because a choice that changes silently across a
# `git pull && ./install.sh` is the failure the mechanism exists to prevent. Reference
# roots and store name where their value came from in the condensed header whenever it
# differs from the default; the port's provenance is --verbose-only, since the number
# alone (always shown, for the verify command) is what a silent-drift reader needs on the
# bounded run. The plist stopped being the record once the launcher started baking these
# values (step 2); the files in $SECRET_DIR are it now.
#
# The port earns it most sharply: reverting a custom one to the default means the old daemon
# still holds the custom port, the new job binds the default, and launchd throttles the
# restart loop with nothing on screen naming the cause.
#
# Kept in step with src/handoff.mjs's DEFAULT_PORT; test/check-install.mjs asserts it.
DEFAULT_PORT=7391
if [ -n "${CLAUDE_BOARD_PORT:-}" ]; then
  PORT="$CLAUDE_BOARD_PORT"
  PORT_FROM="CLAUDE_BOARD_PORT"
elif [ -s "$PORT_RECORD_FILE" ]; then
  PORT="$(cat "$PORT_RECORD_FILE")"
  PORT_FROM="carried forward from $PORT_RECORD_FILE"
elif PORT="$("$PLUTIL_CMD" -extract EnvironmentVariables.CLAUDE_BOARD_PORT raw -o - "$PLIST_PATH" 2>/dev/null)" && [ -n "$PORT" ]; then
  PORT_FROM="carried forward from $PLIST_PATH (migrated to $PORT_RECORD_FILE)"
else
  PORT="$DEFAULT_PORT"
  PORT_FROM="default"
fi
# Validated whichever of the four it came from: a corrupt record bakes its bytes in as
# readily as a typo does, and `<string></string>` in a launchd job binds the wrong thing.
case "$PORT" in
  ''|*[!0-9]*) PORT_OK=0 ;;
  *) if [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; then PORT_OK=1; else PORT_OK=0; fi ;;
esac
if [ "$PORT_OK" -ne 1 ]; then
  echo "error: the port must be a number between 1 and 65535 — got '$PORT' [$PORT_FROM]." >&2
  exit 1
fi

# The allowlist a content reference may resolve inside, on top of the board's own project
# directory (ADR.md entry 3, src/resolve.mjs). Three directories under ~/.claude rather
# than the tree, which also holds settings.json, .credentials.json and every project's
# transcripts; plus the render directory, so an agent can reference a stage it just
# rendered instead of inlining the bytes. Keep in step with DEFAULT_REF_ROOTS in
# src/resolve.mjs; test/check-install.mjs asserts it.
#
# THIS IS THE ONLY PLACE THE DEFAULT LIVES. src/resolve.mjs reads an absent
# CLAUDE_BOARD_REF_ROOTS as an EMPTY allowlist, deliberately: the daemon restarts itself on
# any src/ change, so a default in code would widen the boundary during a `git pull`,
# unannounced. Written here, it arrives only when someone runs the installer.
#
# Carry-forward applies (see the port above), with one addition from ADR.md entry 36:
# carried forward is not frozen. The widening loop below re-adds any of today's defaults
# the record is missing and prints what it added, because a record written before
# ~/Documents/renders joined the defaults would otherwise stay short of it forever. An
# operator's narrowing survives only for directories the defaults do not name; a genuinely
# narrow list needs an explicit CLAUDE_BOARD_REF_ROOTS, not the record's inertia.
DEFAULT_REF_ROOTS="$HOME/.claude/skills:$HOME/.claude/commands:$HOME/.claude/agents:$HOME/Documents/renders"
REF_ROOTS_CARRIED=0
if [ -n "${CLAUDE_BOARD_REF_ROOTS+set}" ]; then
  REF_ROOTS="$CLAUDE_BOARD_REF_ROOTS"
  REF_ROOTS_FROM="CLAUDE_BOARD_REF_ROOTS"
elif [ -f "$REF_ROOTS_RECORD_FILE" ]; then
  REF_ROOTS="$(cat "$REF_ROOTS_RECORD_FILE")"
  REF_ROOTS_FROM="carried forward from $REF_ROOTS_RECORD_FILE"
  REF_ROOTS_CARRIED=1
elif REF_ROOTS="$("$PLUTIL_CMD" -extract EnvironmentVariables.CLAUDE_BOARD_REF_ROOTS raw -o - "$PLIST_PATH" 2>/dev/null)"; then
  # Migration, at most once per machine (the record is written below). plutil exit 0 means
  # the key was present, empty string included -- an empty carried value is a value, not a
  # missing one, and REF_ROOTS_CARRIED=1 sends it through the widening loop like any other
  # record, so it comes out holding today's defaults. Only the explicit-env branch pins a
  # narrow list.
  REF_ROOTS_FROM="carried forward from $PLIST_PATH (migrated to $REF_ROOTS_RECORD_FILE)"
  REF_ROOTS_CARRIED=1
else
  REF_ROOTS="$DEFAULT_REF_ROOTS"
  REF_ROOTS_FROM="default"
fi

# The widening loop (ADR.md entry 36). REF_ROOTS_WIDENED collects exactly what was added so
# the print block below can name it; that print is load-bearing, since a read allowlist
# growing with nothing on screen is the failure the whole mechanism prevents. Only carried
# records go through it -- an explicit variable means what it says, and the default already
# names everything there is to add.
REF_ROOTS_WIDENED=""
if [ "$REF_ROOTS_CARRIED" -eq 1 ]; then
  OLD_IFS="$IFS"
  IFS=:
  for default_dir in $DEFAULT_REF_ROOTS; do
    IFS="$OLD_IFS"
    case ":$REF_ROOTS:" in
      *":$default_dir:"*) ;;
      *)
        if [ -z "$REF_ROOTS" ]; then
          REF_ROOTS="$default_dir"
        else
          REF_ROOTS="$REF_ROOTS:$default_dir"
        fi
        if [ -z "$REF_ROOTS_WIDENED" ]; then
          REF_ROOTS_WIDENED="$default_dir"
        else
          REF_ROOTS_WIDENED="$REF_ROOTS_WIDENED:$default_dir"
        fi
        ;;
    esac
    IFS=:
  done
  IFS="$OLD_IFS"
fi

# The store, same carry-forward. Unlike the roots there is no default to write: absent
# means the key is omitted and src/store.mjs picks its own, so an install that never
# mentions CLAUDE_BOARD_HOME leaves the plist byte-identical. BOARD_HOME_FROM empty is the
# marker for "never chose one" and has to stay distinguishable from "chose the default",
# which is what BOARD_HOME_XML further down keys on.
if [ -n "${CLAUDE_BOARD_HOME+set}" ]; then
  BOARD_HOME="$CLAUDE_BOARD_HOME"
  BOARD_HOME_FROM="CLAUDE_BOARD_HOME"
elif [ -s "$BOARD_HOME_RECORD_FILE" ]; then
  # -s, not -f: a zero-byte record is residue from an empty CLAUDE_BOARD_HOME (now refused
  # in preflight), not a store choice. Read as "no choice" it falls through to the default
  # and the persistence step deletes it, so a machine carrying one heals on the next run.
  BOARD_HOME="$(cat "$BOARD_HOME_RECORD_FILE")"
  BOARD_HOME_FROM="carried forward from $BOARD_HOME_RECORD_FILE"
elif BOARD_HOME="$("$PLUTIL_CMD" -extract EnvironmentVariables.CLAUDE_BOARD_HOME raw -o - "$PLIST_PATH" 2>/dev/null)"; then
  # Migration -- see the identical branch on CLAUDE_BOARD_REF_ROOTS.
  BOARD_HOME_FROM="carried forward from $PLIST_PATH (migrated to $BOARD_HOME_RECORD_FILE)"
else
  BOARD_HOME=""
  BOARD_HOME_FROM=""
fi

# The launcher bakes CLAUDE_BOARD_STORE_DIR unconditionally, so it needs a real path even
# when nobody chose one: the operator's choice, else the same default src/store.mjs would
# compute. Kept in step with it, as DEFAULT_REF_ROOTS is with src/resolve.mjs.
if [ -n "$BOARD_HOME_FROM" ]; then
  EFFECTIVE_BOARD_HOME="$BOARD_HOME"
else
  EFFECTIVE_BOARD_HOME="$HOME/Library/Application Support/claude-board"
fi

cbs_header "claude-board" "$PORT"
# The condensed header prints only a value that differs from its built-in default;
# repo/daemon/mcp are dropped outright (always derivable from the clone, never a choice).
# --verbose restores the full header, every value named regardless. The widen line is the
# one value ALWAYS printed when it fires, independent of this rule (ADR.md entry 36) -- an
# unasked-for widen that prints nothing is the failure carry-forward exists to prevent, so
# it must not be folded away by any later tightening of this header.
if [ "$CLAUDE_BOARD_VERBOSE" = "1" ]; then
  cbs_config_line "repo" "$REPO_DIR"
  cbs_config_line "daemon" "$DAEMON_PATH"
  cbs_config_line "mcp" "$MCP_PATH"
fi
if [ "$CLAUDE_BOARD_VERBOSE" = "1" ] || [ "$REF_ROOTS" != "$DEFAULT_REF_ROOTS" ]; then
  # Spelled out rather than folded into ${REF_ROOTS:-...}: an apostrophe in that word is a
  # quote character to bash even inside double quotes, and swallows the rest of the script
  # up to the next one. QUIRKS.md.
  if [ -n "$REF_ROOTS" ]; then
    cbs_config_line "reference roots" "$REF_ROOTS" "$REF_ROOTS_FROM"
  else
    cbs_config_line "reference roots" "none (resolves inside the board project directory only)" "$REF_ROOTS_FROM"
  fi
fi
if [ -n "$REF_ROOTS_WIDENED" ]; then
  cbs_config_line "widened by the current defaults" "$REF_ROOTS_WIDENED"
fi
if [ -n "$BOARD_HOME_FROM" ]; then
  cbs_config_line "store" "$BOARD_HOME" "$BOARD_HOME_FROM"
elif [ "$CLAUDE_BOARD_VERBOSE" = "1" ]; then
  cbs_config_line "store" "~/Library/Application Support/claude-board" "default"
fi
if [ "$CLAUDE_BOARD_VERBOSE" = "1" ]; then
  cbs_config_line "port" "$PORT" "$PORT_FROM"
fi

# --- 0. the local secret ----------------------------------------------------
# The credential separating this machine's shim from any other local process (SECURITY.md).
# Required on every route but /api/health, reads included -- a browser's cookie is derived
# from this file. /api/health stays open so the health gate below can use plain curl.
#
# NEVER ROTATED once it exists. Rotating 401s every shim already running against the old
# value, i.e. every live session loses its board mid-review, and re-running this script is
# routine. Generated before launchd is reloaded, so the daemon has one to read.
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"
if [ -s "$SECRET_FILE" ]; then
  cbs_step_ok "secret" "already present"
else
  # OS CSPRNG, 32 bytes as hex. The umask keeps it from being briefly world-readable
  # between creation and chmod; the chmod runs anyway, so a pre-existing empty file with
  # looser modes is corrected rather than trusted.
  ( umask 077; "$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$SECRET_FILE" )
  chmod 600 "$SECRET_FILE"
  cbs_step_ok "secret" "generated" "$(display_path "$SECRET_FILE")"
fi

# Write the carry-forward records, into the same 0700 directory as the secret.
#
# Roots and port unconditionally, whatever the value's source: today's default is
# tomorrow's carried value, so a machine on 7391 keeps landing on 7391 even if the default
# moves. The store only when the operator actually chose one -- writing it always would
# freeze today's default in as a future explicit choice.
printf '%s' "$REF_ROOTS" > "$REF_ROOTS_RECORD_FILE"
if [ -n "$BOARD_HOME_FROM" ]; then
  printf '%s' "$BOARD_HOME" > "$BOARD_HOME_RECORD_FILE"
else
  # Also repairs a zero-byte record: read as "no choice" above, deleted here rather than
  # re-read forever.
  rm -f "$BOARD_HOME_RECORD_FILE"
fi
printf '%s' "$PORT" > "$PORT_RECORD_FILE"
# `/file/` and its allowlist are gone (ADR.md entry 38); clear what an older install left.
rm -f "$SERVE_ROOTS_RECORD_FILE"

# The checkout record: where the plugin-origin relocation actually put the tree, so
# uninstall.sh removes what was installed rather than whatever sits at the default
# path. A checkout-origin run (the marker is the proof) records itself; a clone-origin
# run is a takeover -- every registration this run writes points at the clone, so a
# marker-bearing checkout is stale the moment this run succeeds, and is taken back
# here the way uninstall.sh would take it back. Marker-gated like every checkout
# deletion; a directory without the marker is not ours and is left alone, silently
# (the plugin-origin path already refused to relocate onto it, so reaching one here
# means the user built it by hand).
CHECKOUT_RECORD_FILE="$SECRET_DIR/checkout"
if [ -f "$REPO_DIR/$CHECKOUT_MARKER" ]; then
  printf '%s' "$REPO_DIR" > "$CHECKOUT_RECORD_FILE"
else
  STALE_CHECKOUT="$(cat "$CHECKOUT_RECORD_FILE" 2>/dev/null || true)"
  if [ -z "$STALE_CHECKOUT" ]; then STALE_CHECKOUT="$CHECKOUT_DIR"; fi
  if [ "$STALE_CHECKOUT" != "$REPO_DIR" ] && [ -d "$STALE_CHECKOUT" ] && [ -f "$STALE_CHECKOUT/$CHECKOUT_MARKER" ]; then
    rm -rf "$STALE_CHECKOUT"
    cbs_step_ok "checkout" "removed, superseded" "$(display_path "$STALE_CHECKOUT")"
  fi
  rm -f "$CHECKOUT_RECORD_FILE"
fi

# --- content hashing helpers -------------------------------------------------
# Used below by the launcher bundle step to decide whether it needs rebuilding.

sha256_file() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}

# CALLERS MUST PASS ASCII (digests, identifiers -- not raw paths). A process argument
# reaches node as UTF-8 and a filename need not be; a stray byte is replaced on the way in,
# and a stamp that cannot tell two builds apart is a bundle that never rebuilds.
#
# The health gate at step 4 is the one exception, exempt for the reason the rule exists: it
# hashes the daemon's program path and compares against a digest the daemon made from its
# own process.argv[1], which arrived through execve and was decoded identically. Both sides
# lose the same bytes to the same replacement, so the path still matches itself.
sha256_string() {
  "$NODE_BIN" -e '
    const crypto = require("node:crypto");
    process.stdout.write(crypto.createHash("sha256").update(process.argv[1], "utf8").digest("hex"));
  ' "$1"
}

# Digest of bin/daemon.mjs plus everything under src/, folded into the launcher stamp so an
# edit in THE CLONE forces a rebuild instead of "already current" over stale code. One node
# invocation for the whole tree: this runs on every install, no-op ones included, because
# the stamp has to be computed before it can be compared.
#
# DETERMINISTIC BY CONSTRUCTION. readdirSync order is not documented as stable, so paths
# are collected and sorted before anything is hashed, and the digest folds each file's own
# hash paired with its relative path rather than concatenating raw bytes -- no dependence on
# mtime, inode, or filesystem order. test/check-install-payload.mjs pins this against a
# real filesystem.
payload_digest() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const crypto = require("node:crypto");
    const root = process.argv[1];
    function walk(dir) {
      let out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out = out.concat(walk(full));
        else if (entry.isFile()) out.push(full);
        // Refuse loudly rather than skip: isFile() is FALSE for a symlink, whose bytes
        // would never enter the digest while cp staged it into the signed bundle as a link
        // pointing outside the seal -- signature and stamp both attesting to content
        // neither covers. One-line message and a clean exit, not a thrown stack trace, so
        // the caller can turn it into launcher_degraded like every other build-input problem.
        else {
          process.stderr.write("src/ contains a non-regular file the bundle signature cannot cover: " + path.relative(root, full) + "\n");
          process.exit(1);
        }
      }
      return out;
    }
    const files = [path.join(root, "bin", "daemon.mjs"), ...walk(path.join(root, "src"))];
    const rels = files.map(f => path.relative(root, f)).sort();
    const digest = crypto.createHash("sha256");
    for (const rel of rels) {
      const fileHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");
      digest.update(fileHash);
      digest.update("  ");
      digest.update(rel);
      digest.update("\n");
    }
    process.stdout.write(digest.digest("hex"));
  ' "$1"
}

# --- escaping helpers -------------------------------------------------------
# Two destinations, two rules. A clone path is a filename in both, so it may hold any byte
# but NUL and `/`.
#
# LC_ALL=C ON BOTH. Under a UTF-8 locale BSD sed refuses input that is not valid UTF-8
# ("RE error: illegal byte sequence") and exits non-zero, which under `set -euo pipefail`
# aborts the install part-way through on one stray byte in a clone path. The C locale
# passes bytes through untouched.

# For XML: `&`, `<` and `>` are legal in a filename. Unescaped, `&` makes a plist plutil
# rejects while this script exits 0 and launchd has nothing to load.
xml_escape() {
  printf '%s' "$1" | LC_ALL=C sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# For a C string literal in the generated launcher_paths.h: an unescaped backslash or quote
# ends the literal early, turning a path into a syntax error or into a different path.
# Order matters -- backslashes first, or the one added to escape a quote gets escaped too.
#
# A newline cannot be escaped here (sed is line-oriented), so the caller refuses it instead.
c_escape() {
  printf '%s' "$1" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# --- 1b. the launcher app bundle --------------------------------------------
# TCC gates ~/Documents, ~/Desktop and ~/Downloads per application, and "the application"
# is whatever the plist names. Naming `node` means the only grant that unblocks a board
# covers every node program on the machine -- and dies at the next `brew upgrade node`,
# homebrew's node being ad-hoc signed under a versioned Cellar path. So the plist names
# ~/Applications/claude-board.app instead. Why it forks node: bin/launcher.c. What the
# grant widens: SECURITY.md.
#
# ASK ONCE. TCC pins a grant to the code signature, so any rebuild silently revokes it, and
# this script is the routine way to take an update. The stamp is what keeps a run that
# would produce the same bundle from touching it at all.
#
# THE SIGNATURE COVERS THE PAYLOAD. bin/daemon.mjs and src/ are copied into
# Contents/Resources BEFORE codesign runs, so the signature and `codesign --verify` cover
# the code that actually runs under the granted identity, and payload_digest is folded into
# the stamp so editing it in the clone forces a rebuild. Otherwise anything that could
# write the clone would own the grant with no recompile. The copy preserves bin/'s and
# src/'s relative layout, so daemon.mjs's own `../src/server.mjs` import resolves unchanged.
#
# NOT copied: mcp.mjs and authorize.mjs are the shim, invoked by callers at this clone's
# absolute path and never through the granted identity; launcher.c is a build input.
LAUNCHER_STAMP_FILE="$SECRET_DIR/launcher.stamp"
USE_LAUNCHER=0
# Gates the "grant it in System Settings" notice at the end: only a bundle built by THIS
# run has lost its grant, and a notice printed on every reinstall stops meaning anything.
LAUNCHER_IS_NEW=0

# $1=short reason, styled as the "launcher" step's warned result. Every cause shares this
# one consequence line -- the daemon still runs as node itself, so a board reference into
# ~/Documents, ~/Desktop or ~/Downloads fails with EPERM, macOS having no application of
# ours to grant. Callers add whatever detail is specific to their own cause (a fix
# instruction, or cbs_print_captured for a cause that ran a captured command) right after
# calling this.
launcher_degraded() {
  cbs_step_warn "launcher" "$1"
  cbs_detail "a reference into ~/Documents will fail with EPERM"
}

# bin/launcher.c uses a QUOTED #include for its generated header, which searches the
# including file's own directory first. Compiling in place would therefore let a
# launcher_paths.h planted in bin/ shadow the real one and get baked into a bundle macOS
# trusts with the Documents grant. The build below copies the source next to the real
# header in $LAUNCHER_BUILD_DIR and compiles there with -iquote and no include path back
# into the clone, which makes the shadow powerless by construction. A leftover header is
# still named -- an older install.sh generated one in place, so it is plausible and
# innocent, and refusing would turn a stale file into a failed install.
if [ -f "$REPO_DIR/bin/launcher_paths.h" ]; then
  cbs_step_warn "launcher" "ignoring stray $REPO_DIR/bin/launcher_paths.h"
  cbs_detail "compiled from a copy staged outside the clone -- this file cannot affect the build"
fi

LAUNCHER_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-board-launcher.XXXXXX")"
# cbs_spinner_stop rides along with the build-dir cleanup: the fence installs no EXIT
# trap of its own so this script can own one (see the fence's own header comment), and
# this is that obligation. Both spinners below (launcher build+sign, health wait) start
# and stop around a window that can end in an unguarded pipeline assignment failing under
# `set -e`, not just their own ordinary exit -- without this, a background spinner
# outlives the script and keeps overwriting the terminal's prompt forever. Safe to call
# even when no spinner is running (CBS_SPINNER_PID empty is a no-op).
trap 'cbs_spinner_stop; rm -rf "$LAUNCHER_BUILD_DIR"' EXIT

STAGED_APP="$LAUNCHER_BUILD_DIR/${LABEL}.app"
STAGED_INFO="$STAGED_APP/Contents/Info.plist"
STAGED_HEADER="$LAUNCHER_BUILD_DIR/launcher_paths.h"
STAGED_LAUNCHER_SRC="$LAUNCHER_BUILD_DIR/launcher.c"
# notify.m and menubar.m include nothing of ours, so neither can be shadowed. Staged
# anyway: one rule for all three sources beats one rule per source.
STAGED_NOTIFY_SRC="$LAUNCHER_BUILD_DIR/notify.m"
STAGED_MENUBAR_SRC="$LAUNCHER_BUILD_DIR/menubar.m"
mkdir -p "$STAGED_APP/Contents/MacOS"
cp "$LAUNCHER_SRC" "$STAGED_LAUNCHER_SRC"
cp "$LAUNCHER_NOTIFY_SRC" "$STAGED_NOTIFY_SRC"
cp "$LAUNCHER_MENUBAR_SRC" "$STAGED_MENUBAR_SRC"

# The one filename byte c_escape cannot handle -- cheaper to refuse by name than to debug
# from a compiler error.
#
# KEEP THIS TEST IN STEP WITH THE HEADER BELOW. Every value it bakes is here, because a
# newline in the store or the reference roots makes the same unterminated string literal as
# one in the daemon path. Only CLAUDE_BOARD_PATH is absent, being a constant in this script.
# DAEMON_PATH rides along because the DEGRADED path runs it by name.
case "$NODE_BIN$DAEMON_PATH$BUNDLED_DAEMON_PATH$REPO_DIR$HOME$EFFECTIVE_BOARD_HOME$REF_ROOTS" in
  *$'\n'*) LAUNCHER_NEWLINE_IN_PATH=1 ;;
  *) LAUNCHER_NEWLINE_IN_PATH=0 ;;
esac

# Computed up front so a payload the signature cannot honestly cover degrades like every
# other build-input problem, instead of aborting the install under `set -e`.
PAYLOAD_DIGEST_ERR=""
if ! PAYLOAD_DIGEST="$(payload_digest "$REPO_DIR" 2>&1)"; then
  PAYLOAD_DIGEST_ERR="$PAYLOAD_DIGEST"
  PAYLOAD_DIGEST=""
fi

# The two multi-command build steps below, each wrapped as a function so cbs_run_captured
# -- which takes a single command -- can capture the whole step's merged output at once
# rather than once per invocation. No per-command 2>&1 inside either: cbs_run_captured's
# own capture already merges the function's combined stdout and stderr.
build_launcher_binary() {
  "$CC_CMD" -O2 -Wall -fobjc-arc -c -o "$LAUNCHER_BUILD_DIR/notify.o" "$STAGED_NOTIFY_SRC" \
    && "$CC_CMD" -O2 -Wall -fobjc-arc -c -o "$LAUNCHER_BUILD_DIR/menubar.o" "$STAGED_MENUBAR_SRC" \
    && "$CC_CMD" -O2 -Wall -o "$STAGED_APP/Contents/MacOS/$LABEL" \
         -iquote "$LAUNCHER_BUILD_DIR" "$STAGED_LAUNCHER_SRC" \
         "$LAUNCHER_BUILD_DIR/notify.o" "$LAUNCHER_BUILD_DIR/menubar.o" \
         -framework Foundation -framework UserNotifications -framework AppKit
}

stage_launcher_payload() {
  mkdir -p "$STAGED_APP/Contents/Resources/bin" "$STAGED_APP/Contents/Resources/src" \
    && cp "$REPO_DIR/bin/daemon.mjs" "$STAGED_APP/Contents/Resources/bin/daemon.mjs" \
    && cp -RL "$REPO_DIR/src/." "$STAGED_APP/Contents/Resources/src/" \
    && { [ ! -f "$LAUNCHER_ICON_SRC" ] || cp "$LAUNCHER_ICON_SRC" "$STAGED_APP/Contents/Resources/${LABEL}.icns"; }
}

if [ "$LAUNCHER_NEWLINE_IN_PATH" -eq 1 ]; then
  launcher_degraded "one of the values baked into the launcher (an interpreter, daemon, clone, home, store or reference-root path) contains a newline, which cannot be written into a C string literal"
elif [ -n "$PAYLOAD_DIGEST_ERR" ]; then
  launcher_degraded "$PAYLOAD_DIGEST_ERR"
else
  # EDITING ANYTHING BELOW, THE COMMENT INCLUDED, REBUILDS EVERY BUNDLE ON EVERY MACHINE.
  # This file's sha256 is in $LAUNCHER_STAMP, so its bytes are a bundle input like any
  # other, and a rebuild silently revokes the user's Documents grant (see the step header).
  cat > "$STAGED_HEADER" <<HEADER
/* Generated by install.sh — not checked in, rebuilt from scratch on every run.
 * CLAUDE_BOARD_NODE and CLAUDE_BOARD_DAEMON are the only two things bin/launcher.c will
 * ever execute, deliberately: see the header comment there for why the target is
 * compiled in rather than read from argv. CLAUDE_BOARD_DAEMON here is the path INSIDE
 * the bundle (Contents/Resources/bin/daemon.mjs) now that install.sh stages the daemon's
 * own code there — see "the launcher app bundle" above — not the clone's bin/daemon.mjs.
 * The five below them are the environment that exec gets — HOME, PATH, the two
 * CLAUDE_BOARD_* variables that decide what the daemon may read and write, and
 * CLAUDE_BOARD_REPO_ROOT, which decides none of those but is baked in for the identical
 * reason: it is what src/handoff.mjs's recoveryCommand() prints as the path to
 * bin/authorize.mjs, and that file is the clone's, not the bundle's (authorize.mjs is
 * deliberately not staged into Resources/ — see above), so a daemon running from inside
 * the bundle needs to be told where the clone actually is rather than guessing from its
 * own location the way it could when it ran bin/daemon.mjs directly out of the clone.
 * All are baked in for the identical reason and never taken from whatever the plist's
 * EnvironmentVariables dict says (see bin/launcher.c, OVERRIDE_ENV). */
#define CLAUDE_BOARD_NODE "$(c_escape "$NODE_BIN")"
#define CLAUDE_BOARD_DAEMON "$(c_escape "$BUNDLED_DAEMON_PATH")"
#define CLAUDE_BOARD_HOME_DIR "$(c_escape "$HOME")"
#define CLAUDE_BOARD_PATH "$(c_escape "$LAUNCHER_CHILD_PATH")"
#define CLAUDE_BOARD_STORE_DIR "$(c_escape "$EFFECTIVE_BOARD_HOME")"
#define CLAUDE_BOARD_REF_ROOTS_VALUE "$(c_escape "$REF_ROOTS")"
#define CLAUDE_BOARD_REPO_ROOT_VALUE "$(c_escape "$REPO_DIR")"
HEADER

  # CFBundleIconFile only when there is an icns to name: naming a missing one gives a broken
  # icon reference rather than the system default. Spliced in with a trailing newline inside
  # the variable and no blank line when empty, so a clone without an icns produces
  # byte-identical plist bytes -- moved bytes are a rebuild, and a rebuild is the grant.
  ICON_PLIST_ENTRY=""
  if [ -f "$LAUNCHER_ICON_SRC" ]; then
    ICON_PLIST_ENTRY="	<key>CFBundleIconFile</key>
	<string>$(xml_escape "$LABEL")</string>
"
  fi

  # LSUIElement, NEVER LSBackgroundOnly (ADR.md entry 75). Both are "no Dock tile, no menu
  # bar", but LSBackgroundOnly declares an app that may never be brought forward, and
  # bin/notify.m serves a banner click by activating the bundle to hand the response over --
  # every click failed with -600 and "The application claude-board.app is not open anymore."
  # Adding LSBackgroundOnly back beside LSUIElement reopens that: both present is ambiguous
  # and LSBackgroundOnly is documented to win, so test/check-install.mjs asserts LSUIElement
  # true AND LSBackgroundOnly absent.
  #
  # NSAppleEventsUsageDescription (ADR.md entry 93) is the sentence macOS shows in the
  # "claude-board wants to control Safari" dialog, which a board-opening click costs once
  # per browser when it asks whether one is already showing that board
  # (bin/launcher.c's cb_surface_tab). Apple documents it as required of any app that sends
  # Apple Events; what an omitted one does here is unmeasured.
  #
  # None of the keys blocks notifications or the one-time permission prompt -- measured,
  # QUIRKS.md. CFBundleVersion stays off package.json's version: a version bump would move
  # these bytes, move the signature, and cost the grant for nothing.
  cat > "$STAGED_INFO" <<INFO
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${ICON_PLIST_ENTRY}	<key>CFBundleIdentifier</key>
	<string>$(xml_escape "$BUNDLE_ID")</string>
	<key>CFBundleName</key>
	<string>$(xml_escape "$LABEL")</string>
	<key>CFBundleDisplayName</key>
	<string>$(xml_escape "$LABEL")</string>
	<key>CFBundleExecutable</key>
	<string>$(xml_escape "$LABEL")</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSAppleEventsUsageDescription</key>
	<string>claude-board brings the tab a board is already open in to the front, instead of opening a second one.</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
</dict>
</plist>
INFO

  # EVERY INPUT THAT DECIDES THE BUNDLE'S BYTES, AND NOTHING THAT DOES NOT. An input left
  # out is one whose edits never rebuild the bundle, silently, on every later install;
  # anything extra costs the user their grant for nothing.
  #
  # Composed of hex digests and an ASCII identifier, never raw paths, so it is safe to hand
  # to sha256_string whatever bytes the clone path holds. "none" rather than a skipped
  # field when there is no icns, so adding one later still moves the stamp.
  LAUNCHER_ICON_DIGEST="none"
  if [ -f "$LAUNCHER_ICON_SRC" ]; then
    LAUNCHER_ICON_DIGEST="$(sha256_file "$LAUNCHER_ICON_SRC")"
  fi
  # All three sources, the icon, both generated plists, the identifier, and the payload.
  LAUNCHER_STAMP="$(sha256_string "$(sha256_file "$LAUNCHER_SRC")|$(sha256_file "$LAUNCHER_NOTIFY_SRC")|$(sha256_file "$LAUNCHER_MENUBAR_SRC")|$LAUNCHER_ICON_DIGEST|$(sha256_file "$STAGED_HEADER")|$(sha256_file "$STAGED_INFO")|$BUNDLE_ID|$PAYLOAD_DIGEST")"

  # Two lines: the input stamp, then the sha256 of the executable as installed. The first
  # covers what DECIDES the bytes, the second the bytes themselves, so editing the installed
  # binary directly still forces a rebuild. A one-line file from an older install reads the
  # second as empty, which can never equal a real digest, so it rebuilds once.
  RECORDED_LAUNCHER_STAMP=""
  RECORDED_EXEC_STAMP=""
  if [ -f "$LAUNCHER_STAMP_FILE" ]; then
    RECORDED_LAUNCHER_STAMP="$(sed -n '1p' "$LAUNCHER_STAMP_FILE")"
    RECORDED_EXEC_STAMP="$(sed -n '2p' "$LAUNCHER_STAMP_FILE")"
  fi

  # "Already current" means present, signed, and the bytes the stamp describes -- not
  # merely that a stamp file says so. The app lives in ~/Applications, where a user may
  # trash it or overwrite the executable in place, and a stamp that outlived what it
  # stamped leaves the plist pointing at something wrong or trusts a tampered binary.
  if [ -n "$RECORDED_LAUNCHER_STAMP" ] && [ "$RECORDED_LAUNCHER_STAMP" = "$LAUNCHER_STAMP" ] \
     && [ -x "$APP_EXEC" ] && [ -n "$RECORDED_EXEC_STAMP" ] \
     && [ "$RECORDED_EXEC_STAMP" = "$(sha256_file "$APP_EXEC")" ] \
     && "$CODESIGN_CMD" --verify "$APP_PATH" >/dev/null 2>&1; then
    USE_LAUNCHER=1
    cbs_step_ok "launcher" "already current" "$(display_path "$APP_PATH")"
  elif ! command -v "$CC_CMD" >/dev/null 2>&1; then
    launcher_degraded "no C compiler, installing without the bundle"
    cbs_detail "fix: xcode-select --install, then re-run"
  elif ! command -v "$CODESIGN_CMD" >/dev/null 2>&1; then
    launcher_degraded "no codesign, installing without the bundle"
    cbs_detail "fix: xcode-select --install, then re-run"
  # -Wall but NOT -Werror: a future compiler inventing a warning must not fail a routine
  # reinstall. -iquote, not -I, so no include path reaches back into the clone.
  #
  # Three invocations because the sources are two languages -- clang objects to -fobjc-arc
  # beside a .c file. The .m halves compile to objects, then launcher.c links against both
  # with Foundation and UserNotifications for posting and AppKit for the click, since a
  # notification's delegate only fires on a running app (ADR.md entries 57 and 72;
  # bin/notify.m's header for why one binary, bin/menubar.m's for why one bundle).
  #
  # All of it inside the `if !`, so a compile failure degrades rather than aborting. Wrapped
  # as a function so cbs_run_captured -- a single command -- can capture all three
  # invocations' merged output as one, surfaced only if this step ends up failing. The
  # spinner starts here: this is the first genuinely slow step in the chain, "launcher
  # compile and sign", and every branch below stops it before printing its own resolving
  # step line (see the EXIT trap above for the path where none of them get to run it).
  elif ! { cbs_spinner_start "launcher"; cbs_run_captured build_launcher_binary; }; then
    cbs_spinner_stop
    launcher_degraded "the launcher failed to compile"
    cbs_print_captured
  # The payload, staged BEFORE signing so the signature covers it (see the step header).
  # mkdir -p first, then cp with an explicit "/." source and "/" destination rather than
  # relying on cp -R's directory-exists-or-not behaviour, which differs by case. The icon
  # rides along under the same signature; copied only if present, matching the plist key,
  # so a clone with no icns builds an unbranded bundle rather than no bundle.
  elif ! cbs_run_captured stage_launcher_payload; then
    cbs_spinner_stop
    launcher_degraded "could not stage the daemon into the bundle"
    cbs_print_captured
  # --force so a re-sign replaces rather than refuses. --identifier explicitly, never
  # inherited from Info.plist: this string IS the grant's name, and editing a plist alone
  # must not be able to change it.
  elif ! cbs_run_captured "$CODESIGN_CMD" --force --sign - --identifier "$BUNDLE_ID" "$STAGED_APP"; then
    cbs_spinner_stop
    launcher_degraded "the launcher bundle failed to sign"
    cbs_print_captured
  elif ! cbs_run_captured "$CODESIGN_CMD" --verify "$STAGED_APP"; then
    cbs_spinner_stop
    launcher_degraded "the launcher bundle did not verify after signing"
    cbs_print_captured
  else
    cbs_spinner_stop
    mkdir -p "$APP_DIR"
    # Signed in staging and swapped in whole, so a failed compile or sign leaves the
    # installed bundle -- and its grant -- exactly as it was. Removing the old one while
    # the daemon runs from it is safe: the running image holds its inode open, and it is
    # booted out and replaced below anyway.
    rm -rf "$APP_PATH"
    mv "$STAGED_APP" "$APP_PATH"
    # Hashed AFTER the mv, so the recorded digest is of the executable a future run will
    # actually find on disk rather than of the staged copy.
    printf '%s\n%s\n' "$LAUNCHER_STAMP" "$(sha256_file "$APP_EXEC")" > "$LAUNCHER_STAMP_FILE"
    USE_LAUNCHER=1
    cbs_step_ok "launcher" "built and signed" "$(display_path "$APP_PATH")"
    LAUNCHER_IS_NEW=1
  fi
fi

# --- 2. launchd plist -------------------------------------------------------
# KEEP THIS BEFORE THE MCP REGISTRATION. The registration is a remove-then-add on config
# this repo does not own, so a launchctl failure after it would strand exactly the half
# this script cannot repair. Owned work first means a failure leaves the registration alone.
mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$LOG_DIR"
# The logs carry whatever the daemon prints about boards -- the user's own questions and
# answers -- so they get the store's owner-only posture.
chmod 700 "$LOG_DIR"
LABEL_X="$(xml_escape "$LABEL")"
NODE_BIN_X="$(xml_escape "$NODE_BIN")"
DAEMON_PATH_X="$(xml_escape "$DAEMON_PATH")"
APP_EXEC_X="$(xml_escape "$APP_EXEC")"
REPO_DIR_X="$(xml_escape "$REPO_DIR")"
OUT_LOG_X="$(xml_escape "$OUT_LOG")"
ERR_LOG_X="$(xml_escape "$ERR_LOG")"
PORT_X="$(xml_escape "$PORT")"

# What launchd execs, and therefore what TCC attributes the daemon's reads to. One string
# where the DEGRADED fallback is two, because the launcher takes no arguments: its target is
# compiled in, so holding the grant is not the same as being able to point it at any code.
if [ "$USE_LAUNCHER" -eq 1 ]; then
  PROGRAM_ARGS_XML="		<string>${APP_EXEC_X}</string>"
else
  PROGRAM_ARGS_XML="		<string>${NODE_BIN_X}</string>
		<string>${DAEMON_PATH_X}</string>"
fi

# The plist carries CLAUDE_BOARD_REF_ROOTS and CLAUDE_BOARD_HOME on the DEGRADED path ONLY.
# A launcher bakes both into itself (bin/launcher.c's OVERRIDE_ENV) and ignores this dict,
# so writing them here too is the second copy the header's third invariant forbids. Without
# a launcher, node has nowhere else to read them from -- and src/resolve.mjs reads an absent
# key as no allowlist at all, not as "ask the launcher", so that branch writes them
# unconditionally.
if [ "$USE_LAUNCHER" -eq 1 ]; then
  EXTRA_ENV_XML=""
else
  REF_ROOTS_X="$(xml_escape "$REF_ROOTS")"
  EXTRA_ENV_XML="		<key>CLAUDE_BOARD_REF_ROOTS</key>
		<string>${REF_ROOTS_X}</string>
"
  # Only when the operator chose a store root, so an install that never mentions
  # CLAUDE_BOARD_HOME leaves the dict byte-identical and the daemon picks its own default.
  if [ -n "$BOARD_HOME_FROM" ]; then
    BOARD_HOME_X="$(xml_escape "$BOARD_HOME")"
    EXTRA_ENV_XML="${EXTRA_ENV_XML}		<key>CLAUDE_BOARD_HOME</key>
		<string>${BOARD_HOME_X}</string>
"
  fi
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL_X}</string>
	<key>ProgramArguments</key>
	<array>
${PROGRAM_ARGS_XML}
	</array>
	<key>WorkingDirectory</key>
	<string>${REPO_DIR_X}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${OUT_LOG_X}</string>
	<key>StandardErrorPath</key>
	<string>${ERR_LOG_X}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>CLAUDE_BOARD_PORT</key>
		<string>${PORT_X}</string>
		<key>CLAUDE_BOARD_LAUNCHD_MARKER</key>
		<string>1</string>
${EXTRA_ENV_XML}	</dict>
</dict>
</plist>
PLIST

# An unparseable plist is otherwise invisible: bootstrap fails, this script exits 0, and
# the user is told the service is running.
if ! "$PLUTIL_CMD" -lint "$PLIST_PATH" >/dev/null; then
  cbs_step_fail "plist" "generated plist is not valid"
  cbs_detail "refusing to continue: $PLIST_PATH"
  exit 1
fi

cbs_step_ok "plist" "written" "$(display_path "$PLIST_PATH")"

# --- 3. load / reload it, idempotently --------------------------------------
# bootout-then-bootstrap rather than a conditional: a bootout of an unloaded job fails
# harmlessly, so a fresh machine and a reinstall take one path, and it picks up a CHANGED
# plist rather than restarting the loaded definition in place.
#
# Every launchctl call is guarded rather than left to `set -e`, because the common reinstall
# genuinely fails once: bootout returns as soon as the job is asked to stop, a KeepAlive job
# is still tearing down, and a bootstrap landing in that window is refused with EBUSY.
# Retrying is the fix. Whether the service came up is settled by the health gate below, not
# by these exit codes.
UID_N="$(id -u)"
DOMAIN="gui/${UID_N}"
TARGET="${DOMAIN}/${LABEL}"

"$LAUNCHCTL_CMD" bootout "$TARGET" >/dev/null 2>&1 || true

BOOTSTRAPPED=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if "$LAUNCHCTL_CMD" bootstrap "$DOMAIN" "$PLIST_PATH" >/dev/null 2>&1; then
    BOOTSTRAPPED=1
    break
  fi
  sleep 0.5
done
if [ "$BOOTSTRAPPED" -ne 1 ]; then
  cbs_step_fail "service" "launchctl bootstrap $TARGET kept failing"
  cbs_detail "the previous job may still be running"
  cbs_detail "try: launchctl bootout $TARGET && bash $0"
  exit 1
fi

"$LAUNCHCTL_CMD" enable "$TARGET" >/dev/null 2>&1 || true
"$LAUNCHCTL_CMD" kickstart -k "$TARGET" >/dev/null 2>&1 || true
cbs_step_ok "service" "loaded"

# --- 4. prove it actually bound before claiming success ----------------------
# "Wrote a plist and called launchctl" is not "running": a syntax error in the daemon, a
# taken port, or a bootstrap that silently did nothing all reach here otherwise, and the
# script prints "installed and running" over them.
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

# THE BUDGET BELOW IS A PERSON'S, NOT A PROCESS'S. A bundle built by THIS run holds no
# grant yet, so if the clone sits in ~/Documents, ~/Desktop or ~/Downloads, reading
# bin/daemon.mjs is itself a gated read and the daemon cannot start until the user clicks
# Allow. macOS raises that prompt against the launchd job, i.e. while this loop waits.
case "$REPO_DIR/" in
  "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*) REPO_IN_PROTECTED_DIR=1 ;;
  *) REPO_IN_PROTECTED_DIR=0 ;;
esac

HEALTH_TRIES=20
if [ "$LAUNCHER_IS_NEW" -eq 1 ] && [ "$REPO_IN_PROTECTED_DIR" -eq 1 ]; then
  HEALTH_TRIES=480   # 0.25s apart, i.e. two minutes to notice a dialog and click it
  echo
  echo "==> asking for access to $(display_path "$(dirname "$REPO_DIR")")"
  echo "    click Allow, no dialog: System Settings -> Privacy & Security -> Files and Folders -> $LABEL"
  echo
fi
# Test seam: the budget above is a person's, and the checks that prove a dead port fails
# the install have nobody to wait for.
HEALTH_TRIES="${CLAUDE_BOARD_HEALTH_TRIES:-$HEALTH_TRIES}"

# WHICH daemon answered, not merely that something did. "A listener on the port" lets a
# hand-run `node bin/daemon.mjs` or a previous install's daemon stand in for a launchd job
# that could not bind and is being throttled into a restart loop. Two facts have to agree:
#
#   IDENTITY. src/server.mjs answers /api/health with a digest of its own program path
#   (DAEMON_ID there), and this run knows exactly which path it pointed launchd at. A
#   digest rather than the path because /api/health is the one uncredentialed route
#   (isOpenRoute in src/server.mjs). Both sides decode through node's argv, so a path that
#   is not valid UTF-8 still matches itself.
#
#   ANCESTRY. The digest alone cannot separate the DEGRADED install from a hand-run
#   `node bin/daemon.mjs` out of the same clone -- same program, same path. So the answering
#   process must also be the launchd job or a descendant of it. Descendant, not equal: the
#   launcher forks node rather than exec'ing it (bin/launcher.c says why), so launchd's pid
#   is the stub's and health answers with the child's. Requiring equality hangs every
#   launcher install here until the budget runs out, then blames a foreign listener.
#
# A mid-probe restart makes the two disagree for one iteration; the loop retries, so the
# race costs a retry rather than the install.
pid_descends_from() {  # <pid> <ancestor-pid>
  _pdf_pid="$1"
  _pdf_hops=0
  # ponytail: 8 hops, walked one `ps` at a time. The real chain is one hop (launcher forks
  # node once) and the bound only exists so a corrupt or racy ppid chain cannot spin. If a
  # future launcher gains a supervision layer, raise the bound; a deeper chain reads as a
  # foreign listener rather than as a hang, which is the safe direction to fail.
  while [ -n "$_pdf_pid" ] && [ "$_pdf_pid" -gt 1 ] 2>/dev/null && [ "$_pdf_hops" -lt 8 ]; do
    [ "$_pdf_pid" = "$2" ] && return 0
    # Empty when the pid is gone, which ends the loop -- `ps` failing and `ps` printing
    # nothing arrive here identically.
    _pdf_pid="$(ps -o ppid= -p "$_pdf_pid" 2>/dev/null | tr -d '[:space:]')"
    _pdf_hops=$((_pdf_hops + 1))
  done
  return 1
}

if [ "$USE_LAUNCHER" -eq 1 ]; then
  HEALTH_DAEMON_PATH="$BUNDLED_DAEMON_PATH"
else
  HEALTH_DAEMON_PATH="$DAEMON_PATH"
fi
HEALTH_DAEMON_ID="$(sha256_string "$HEALTH_DAEMON_PATH")"

cbs_spinner_start "health"
HEALTH_START_SECONDS="$SECONDS"
HEALTHY=0
# Set when something answered the probe but was not this install's daemon, so the failure
# below can name that instead of "the daemon never answered".
HEALTH_FOREIGN=0
for _ in $(seq 1 "$HEALTH_TRIES"); do
  # --noproxy '*' is load-bearing: a corporate or VPN Mac exports ALL_PROXY / http_proxy /
  # https_proxy with no loopback exemption, and curl then asks that proxy for 127.0.0.1,
  # which answers 502 or nothing. The daemon is healthy and the probe never reaches it.
  HEALTH_BODY="$(curl -fsS --noproxy '*' --max-time 2 "$HEALTH_URL" 2>/dev/null)" || HEALTH_BODY=""
  case "$HEALTH_BODY" in
    '') ;;
    *"$HEALTH_DAEMON_ID"*)
      HEALTH_PID="$(printf '%s' "$HEALTH_BODY" | sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p')"
      JOB_PID="$("$LAUNCHCTL_CMD" print "$TARGET" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' | head -n 1)"
      if [ -n "$HEALTH_PID" ] && [ -n "$JOB_PID" ] && pid_descends_from "$HEALTH_PID" "$JOB_PID"; then
        HEALTHY=1; break
      fi
      HEALTH_FOREIGN=1
      ;;
    *) HEALTH_FOREIGN=1 ;;
  esac
  sleep 0.25
done
cbs_spinner_stop
if [ "$HEALTHY" -ne 1 ] && [ "$HEALTH_FOREIGN" -eq 1 ]; then
  cbs_step_fail "health" "something else is listening on 127.0.0.1:${PORT}, not the daemon"
  cbs_detail "this install just set up ($HEALTH_DAEMON_PATH)"
  cbs_detail "a hand-run 'node bin/daemon.mjs', another clone's daemon, or an unrelated program"
  cbs_detail "has the port -- KeepAlive is retrying a job that cannot bind"
  cbs_detail "find it: lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
  cbs_detail "then stop it and re-run, or pick another port with CLAUDE_BOARD_PORT"
  cbs_detail "logs: $(display_path "$OUT_LOG")"
  cbs_detail "      $(display_path "$ERR_LOG")"
  exit 1
fi
if [ "$HEALTHY" -ne 1 ]; then
  cbs_step_fail "health" "never answered $HEALTH_URL"
  cbs_detail "the daemon is NOT running"
  cbs_detail "logs: $(display_path "$OUT_LOG")"
  cbs_detail "      $(display_path "$ERR_LOG")"
  # Named precisely rather than left to the logs, which say "EPERM" and mean "nobody has
  # clicked Allow yet".
  if [ "$USE_LAUNCHER" -eq 1 ] && [ "$REPO_IN_PROTECTED_DIR" -eq 1 ]; then
    cbs_detail "most likely cause: macOS is refusing $LABEL access to $(dirname "$REPO_DIR")"
    cbs_detail "which is where this clone lives, so the daemon cannot read its own code"
    cbs_detail "fix: System Settings -> Privacy & Security -> Files and Folders (find $LABEL)"
    cbs_detail "then: launchctl kickstart -k $TARGET"
  fi
  exit 1
fi
HEALTH_ELAPSED_SECONDS=$((SECONDS - HEALTH_START_SECONDS))
cbs_step_ok "health" "responding" "${HEALTH_ELAPSED_SECONDS}s"

# --- 5. MCP registration ---------------------------------------------------
# Claude Code owns this config, not this repo. Remove-then-add unconditionally: the remove
# is an ignored no-op on a fresh machine and clears a stale registration from another clone
# path, so a second run neither duplicates nor errors. Last, so nothing above can fail with
# this half-rewritten. `claude mcp add`'s own stdout chatter (it prints two lines about
# writing its config) is captured, not shown, on a good run.
"$MCP_CMD" mcp remove "$LABEL" --scope user >/dev/null 2>&1 || true
if ! cbs_run_captured "$MCP_CMD" mcp add "$LABEL" --scope user -- "$NODE_BIN" "$MCP_PATH"; then
  cbs_step_fail "mcp" "'$MCP_CMD mcp add' failed"
  cbs_detail "the daemon is running, but Claude Code has no registration for it"
  cbs_detail "re-run this script once that command works"
  cbs_print_captured
  exit 1
fi
cbs_step_ok "mcp" "registered with claude"

# --- 6. The manual ---------------------------------------------------------
# skills/claude-board/SKILL.md -> where Claude Code looks for a personal skill. Not a
# caller (ADR.md entries 5 and 11): it teaches the `ask` tool's call shape, blocks, widgets,
# packet and failure modes, and decides nothing about when to ask, so callers name it and
# keep only what is specific to them.
#
# Unconditional overwrite -- no hash record, no did-they-edit-it branch. The file is this
# repo's and a copy that quietly stops matching the shim is the failure this step prevents.
# Non-fatal: a daemon and a registration are the install.
if [ ! -f "$SKILL_SRC" ]; then
  cbs_step_warn "manual" "$SKILL_SRC is missing"
  cbs_detail "skills that name the claude-board skill will not find it"
  cbs_detail "the daemon and the MCP registration are unaffected"
elif ! (mkdir -p "$SKILL_DEST_DIR" && cp "$SKILL_SRC" "$SKILL_DEST_DIR/SKILL.md"); then
  cbs_step_warn "manual" "could not write $SKILL_DEST_DIR/SKILL.md"
  cbs_detail "the daemon and the MCP registration are unaffected"
else
  cbs_step_ok "manual" "installed" "$(display_path "$SKILL_DEST_DIR/SKILL.md")"
fi
echo

# Same proxy trap as the health gate above: with a proxy exported and no loopback
# exemption, the plain form reports a board that is up as down.
PROXY_IN_ENV=0
for _proxy_var in ALL_PROXY all_proxy HTTP_PROXY http_proxy HTTPS_PROXY https_proxy; do
  if [ -n "${!_proxy_var:-}" ]; then PROXY_IN_ENV=1; break; fi
done
if [ "$PROXY_IN_ENV" -eq 1 ]; then
  VERIFY_CMD="curl -s --noproxy '*' http://127.0.0.1:${PORT}/api/health"
else
  VERIFY_CMD="curl -s http://127.0.0.1:${PORT}/api/health"
fi
# Authorize and revive are dropped from this footer: the daemon's own refusal page already
# prints the authorize command, and bin/mcp.mjs already prints the revive command on an
# unreachable daemon, so neither is lost by dropping it here.
#
# A correctly signed, perfectly runnable bundle is still refused with "Notifications are
# not allowed for this application" until LaunchServices knows about it. It picks up
# ~/Applications on its own eventually, which the first pomodoro boundary cannot wait for.
# Measured, QUIRKS.md.
#
# Guarded, not a dependency: lsregister lives at a private path, so if Apple moves it the
# scanner registers the bundle a little later and nothing else changes.
#
# NEVER FOR A THROWAWAY BUNDLE, which is why this has a condition beyond "is lsregister
# there". The test suite installs into temp roots, including deliberately corrupt fixtures,
# and each run leaves a PERMANENT record claiming the real bundle id -- 6908 of them
# measured here after a few weeks, nearly all naming paths that no longer exist.
# Notification Center resolves a banner by bundle id and picks whichever record it likes, so
# a dead or tampered one puts "claude-board.app is damaged and can't be opened" on screen
# repeatedly, on a machine whose install is fine.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
# --- BEGIN throwaway-bundle test (byte-identical in uninstall.sh) ---
# True when $1 sits under a throwaway root -- a bundle nobody will ever click, so one with
# no business in a database that keeps its records forever. uninstall.sh carries an exact
# copy (neither script sources the other) and test/check-install.mjs fails if the two drift
# or if any case below stops holding.
is_throwaway_bundle_path() {
  case "$1" in
    /tmp/*|/private/tmp/*|/var/tmp/*|/private/var/tmp/*|/var/folders/*|/private/var/folders/*) return 0 ;;
  esac
  # macOS's own TMPDIR lives under /var/folders and is already matched above; this is for a
  # developer who exported their own, whose temp bundles would otherwise land somewhere no
  # pattern names. Honoured only when it is a real nested directory: TMPDIR=/ or
  # TMPDIR=$HOME would swallow the REAL install instead, silently costing it notifications
  # for the life of the machine, which is a worse bug than the one being prevented.
  _tmproot="${TMPDIR:-}"
  _tmproot="${_tmproot%/}"
  case "$_tmproot" in ''|/|"$HOME") return 1 ;; esac
  case "$1" in "$_tmproot"/*) return 0 ;; esac
  return 1
}
# --- END throwaway-bundle test ---
if [ "$USE_LAUNCHER" -eq 1 ] && ! is_throwaway_bundle_path "$APP_PATH" && [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP_PATH" >/dev/null 2>&1 || true
fi

# Asked at the end of an install somebody is watching, rather than hours later at the first
# pomodoro boundary, where the dialog has no context. `|| true` under `set -e` because a No
# answers the question rather than breaking the install. Idempotent: macOS prompts once per
# bundle and answers from its own record after that.
#
# Nothing may print after the success banner and its footer (ADR.md entry 100), so this
# call -- and the prose it needs -- run here, above them. The prose itself is one of the
# three standing macOS paragraphs: printed in full only when this bundle is new, or under
# --verbose; otherwise the single pointer line below the footer carries it. The call
# itself still runs every time regardless -- it is idempotent, and cheap insurance against
# a grant that got revoked since the last run.
if [ "$USE_LAUNCHER" -eq 1 ] && [ -x "$APP_EXEC" ]; then
  if [ "$LAUNCHER_IS_NEW" -eq 1 ] || [ "$CLAUDE_BOARD_VERBOSE" = "1" ]; then
    # Printed BEFORE the call, which blocks until the dialog is answered -- an unexplained
    # pause with a dialog behind the terminal is the shape of a hung installer.
    echo "==> asking to send notifications"
    echo "    click Allow (interval boundaries, boards left waiting)"
  fi
  "$APP_EXEC" --notify-authorize >/dev/null 2>&1 || true
fi

# The other two standing paragraphs: file access/Files and Folders and the
# launcher-attribution + Alerts block, both new-bundle-only for the same reason.
if [ "$USE_LAUNCHER" -eq 1 ] && ( [ "$LAUNCHER_IS_NEW" -eq 1 ] || [ "$CLAUDE_BOARD_VERBOSE" = "1" ] ); then
  echo "launcher: $APP_PATH ($BUNDLE_ID)"
  # Every successful run, not just the one that built it: this is the answer to "why can't
  # the board read that file", and whoever hits that rarely watched the install scroll past.
  echo "          to macOS, the daemon's file reads and its notifications both come from this app"
  echo "          file access: System Settings -> Privacy & Security -> Files and Folders -> $LABEL"
  # Printed rather than set: Banner vs Alert is per-app and macOS exposes no API for it.
  # Worth printing because owning the bundle is what makes the row say claude-board at all
  # -- posting through osascript put the setting under "Script Editor".
  echo "          keep notifications on screen: System Settings -> Notifications -> $LABEL -> Alerts"
fi

# --- 7. the banner and its footer -------------------------------------------
# The last thing this script prints, whatever else ran above (ADR.md entry 100). Exactly
# two footer entries, verify and logs -- authorize and revive are conveyed elsewhere (see
# above). No blank line between the banner and the footer, so the two read as one group
# and the bounded (already-current, nothing-new) case stays inside the line budget.
cbs_success "claude-board installed and running"
cbs_footer_entry "verify" "$VERIFY_CMD"
cbs_footer_entry "logs" "$(display_path "$LOG_DIR")/daemon.{out,err}.log"
# The collapsed form of the three standing paragraphs above: whenever none of them printed
# in full, this single pointer line still carries what they would have said.
if [ "$USE_LAUNCHER" -eq 1 ] && [ "$LAUNCHER_IS_NEW" -eq 0 ] && [ "$CLAUDE_BOARD_VERBOSE" != "1" ]; then
  printf '     %smacOS file access and notifications: README → "Install"%s\n' "$CBS_DIM" "$CBS_RESET"
fi
