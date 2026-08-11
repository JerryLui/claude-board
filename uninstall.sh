#!/bin/bash
# uninstall.sh — the reverse of install.sh. Removes the two things install.sh puts
# outside this repository:
#
#   1. the launchd job (bootout) and its plist in ~/Library/LaunchAgents,
#   2. the MCP registration (`claude mcp remove --scope user`),
#   3. ~/Applications/claude-board.app, the launcher bundle, the stamp that records
#      what it was built from, and the bundle's LaunchServices record,
#   4. ~/.claude/skills/claude-board/SKILL.md, the manual install.sh step 6 copied
#      there out of this clone.
#
# Order, and why: launchd first (bootout, then delete its plist) so nothing is
# actively supervised while the rest of the teardown runs. The MCP registration is
# next — once the daemon is on its way out, there is no reason to keep telling
# Claude Code to talk to it. The launcher bundle is last, since it is the binary
# the job was running and there is no reason to keep it once the job is gone.
#
# It does NOT remove `/grill` or any other command file (ADR.md entry 5): this
# repo does not install one, so it has nothing of its own to take back. Whatever
# a user has under ~/.claude/commands is theirs, versioned in their own repo on
# their own schedule — uninstalling the board must not reach into it. Step 4 above
# is not a counter-example: that file is a copy of one in this clone, written by
# install.sh, and taking back what you put there is the opposite of reaching in.
#
# It also does NOT touch ~/.claude/settings.json, and never reads or writes that path
# — same shape as `/grill`. The `SessionStart` hook snippet INSTALL.md documents for it
# is applied by the user, by hand; install.sh does not write it, so uninstall.sh has no
# more business deleting it than it does deleting a command file it never installed.
#
# It also removes ONE file the daemon — not install.sh — writes into the store at
# runtime: $CLAUDE_BOARD_HOME/pomodoro.json, the pomodoro timer's absolute deadline,
# long-break cycle count, durations and toggles (ADR.md entry 8, "the daemon owns the
# pomodoro clock"). That narrows the invariant stated two paragraphs down — this
# script never writes to the store — so the narrowing is spelled out here rather than
# left to be noticed: a timer deadline and a break length are configuration this repo
# authored, not review history the user accumulated, so removing that one file is
# correct. It is removed BY EXACT NAME, never the directory and never a glob —
# `boards/` and `pages/`, the actual review history, are untouched. See step 2b.
#
# It also removes $SECRET_DIR/serve_roots if a machine still has one — a record the
# `/file/` route used to carry forward, now that the route and its allowlist are gone
# (ADR.md entry 38). Unlike ref_roots/board_home/port below, this is not a choice worth
# keeping: the thing it configured no longer exists, so it is taken back outright
# rather than named in the "left in place on purpose" summary. See step 2d.
#
# The board_home record is also READ rather than merely reported: it is where install.sh
# writes a custom store, and without it a custom-store uninstall left the timer document
# behind and named the wrong directory as the user's review history. See STORE_DIR below.
#
# Three things are left ON PURPOSE and named by path in the summary this script
# prints at the end: the store (the user's review history), the local secret, and
# the logs. Deleting any of those silently would be a worse bug than leaving too
# much — this is the same judgment call as install.sh never rotating an existing
# secret, just pointed the other way.
#
# Safe to run when nothing is installed: a bootout of a job that was never loaded,
# an `mcp remove` of a registration that was never added, and an `rm` of a plist
# that was never written all fail harmlessly rather than aborting the script, so a
# machine install.sh never touched still gets exit 0. Safe to run twice for the
# same reason — the second run just finds nothing left to remove.
#
# Testing seams (env vars) — identical meaning to install.sh's, so a check can point
# both scripts at the very same temp dir:
#
#   CLAUDE_BOARD_LAUNCH_AGENTS_DIR   default: ~/Library/LaunchAgents
#   CLAUDE_BOARD_LOG_DIR             default: ~/Library/Logs/claude-board (report only)
#   CLAUDE_BOARD_MCP_CMD             default: claude
#   CLAUDE_BOARD_LAUNCHCTL_CMD       default: launchctl
#   CLAUDE_BOARD_SECRET_FILE         default: ~/.config/claude-board/secret (report only)
#   CLAUDE_BOARD_HOME                default: the store install.sh recorded in
#                                     $SECRET_DIR/board_home, or ~/Library/Application
#                                     Support/claude-board if it never recorded one
#                                     (this script removes exactly one file inside it —
#                                     $CLAUDE_BOARD_HOME/pomodoro.json, by exact name,
#                                     see step 2b — and otherwise only reports the path;
#                                     boards/ and pages/ are never touched)
#   CLAUDE_BOARD_APP_DIR             default: ~/Applications
#   CLAUDE_BOARD_SKILLS_DIR          default: ~/.claude/skills
#   CLAUDE_BOARD_COLOR               default: unset (colour on when stdout is a terminal, off
#                                     under NO_COLOR or TERM=dumb; "1" or "always" forces it
#                                     on, even when piped)
#   CLAUDE_BOARD_VERBOSE             default: unset (off) -- this script parses no --verbose
#                                     flag of its own, so this is exactly whatever the
#                                     environment sets, normalised the same way install.sh's
#                                     copy of the fence is)
#
# macOS only, zero dependencies: bash + coreutils + launchctl, nothing this OS
# doesn't already ship.

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

MCP_CMD="${CLAUDE_BOARD_MCP_CMD:-claude}"
LAUNCHCTL_CMD="${CLAUDE_BOARD_LAUNCHCTL_CMD:-launchctl}"
LAUNCH_AGENTS_DIR="${CLAUDE_BOARD_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${CLAUDE_BOARD_LOG_DIR:-$HOME/Library/Logs/claude-board}"
SECRET_FILE="${CLAUDE_BOARD_SECRET_FILE:-$HOME/.config/claude-board/secret}"

APP_DIR="${CLAUDE_BOARD_APP_DIR:-$HOME/Applications}"
SKILLS_DIR="${CLAUDE_BOARD_SKILLS_DIR:-$HOME/.claude/skills}"

LABEL="claude-board"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
SECRET_DIR="$(dirname "$SECRET_FILE")"

# Where the store actually is, which is not always where the default says. install.sh
# writes the operator's chosen CLAUDE_BOARD_HOME into $SECRET_DIR/board_home precisely so a
# later run -- in a shell that never exported the variable -- can find it again; this script
# has the same problem and used to ignore the same answer. The consequence was not cosmetic:
# a custom-store uninstall left pomodoro.json behind (step 2b removes it BY PATH) and then
# named the default directory as "your review history" in the summary, pointing the reader
# at a folder that is not theirs.
#
# Precedence matches install.sh: an explicit variable wins, then the record, then the
# default. -s rather than -f on the record, for the same reason install.sh reads it that
# way: a zero-byte record is residue, not a choice.
BOARD_HOME_RECORD_FILE="$SECRET_DIR/board_home"
if [ -n "${CLAUDE_BOARD_HOME:-}" ]; then
  STORE_DIR="$CLAUDE_BOARD_HOME"
elif [ -s "$BOARD_HOME_RECORD_FILE" ]; then
  STORE_DIR="$(cat "$BOARD_HOME_RECORD_FILE")"
else
  STORE_DIR="$HOME/Library/Application Support/claude-board"
fi
APP_PATH="$APP_DIR/${LABEL}.app"
LAUNCHER_STAMP_FILE="$SECRET_DIR/launcher.stamp"
SKILL_DIR="$SKILLS_DIR/${LABEL}"
SKILL_FILE="$SKILL_DIR/SKILL.md"

cbs_header "claude-board uninstall"
echo

# --- 1. launchd: stop the job, then remove its plist --------------------------
UID_N="$(id -u)"
DOMAIN="gui/${UID_N}"
TARGET="${DOMAIN}/${LABEL}"

if "$LAUNCHCTL_CMD" bootout "$TARGET" >/dev/null 2>&1; then
  cbs_step_ok "job" "stopped" "$TARGET"
else
  # Normal, not fatal: the exact same fact install.sh's own reinstall path
  # already relies on — bootout of a job that isn't loaded just fails harmlessly.
  # Covers "never installed" and "already uninstalled" identically.
  cbs_step_ok "job" "not running" "$TARGET"
fi

if [ -f "$PLIST_PATH" ]; then
  rm -f "$PLIST_PATH"
  cbs_step_ok "plist" "removed" "$PLIST_PATH"
else
  cbs_step_ok "plist" "not present" "$PLIST_PATH"
fi

# --- 1b. the launcher app bundle ----------------------------------------------
# After the bootout, for the same reason the plist goes after it: this is the binary the
# job was running. install.sh built it (see step 1b there), so it is this script's to
# remove — unlike the store, the secret and the logs, none of which install.sh authored
# the CONTENTS of.
#
# The TCC grant that may be attached to it is deliberately NOT touched, and could not be
# without `tccutil reset` blowing away that whole privacy category for every app on the
# machine. It is inert once the bundle is gone — a grant naming an application that no
# longer exists grants nothing — so it is named in the summary rather than chased.
#
# The LaunchServices record IS this script's to remove, by the same authorship rule: step
# 1b of install.sh creates it. A record left behind names a bundle id that is still real
# and a path that is not, and macOS resolving anything to it raises "claude-board.app is
# damaged and can't be opened" long after the uninstall (QUIRKS.md, "`lsregister` records
# are permanent"). Skipped for a temp root because install.sh skips REGISTERING one there,
# so there is nothing to withdraw; that list is duplicated from install.sh and
# test/check-install.mjs fails if the two drift.
#
# AFTER the rm, and inside its success branch, which is the opposite of the obvious order.
# `lsregister -u` works fine on a path that no longer exists, so nothing is lost by
# waiting — while withdrawing FIRST has two failure modes. This script runs under `set -e`,
# so an rm that fails (a `uchg` flag, a read-only mount) would abort having already
# withdrawn: a bundle still on disk, still runnable, and permanently unable to post a
# notification. And in the window between the two, the bundle is still there for any
# LaunchServices rescan to re-register, restoring exactly the record being removed. Dying
# after the rm instead leaves a stale record, which is no worse than never having run.
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
LAUNCHER_BUNDLE_REMOVED=0
if [ -d "$APP_PATH" ]; then
  rm -rf "$APP_PATH"
  LAUNCHER_BUNDLE_REMOVED=1
fi
# Outside that branch on purpose, and this is the fix for the worst leftover this script
# can produce. The withdrawal used to be nested inside "the bundle is still here", so the
# ordinary way a person gets rid of an app -- drag it to the Trash, then run the uninstaller
# -- left the record behind FOREVER: a live bundle id naming a path that no longer exists,
# which macOS resolves a banner to and answers with "claude-board.app is damaged and can't
# be opened", weeks later, on a machine with nothing installed. `lsregister -u` works fine
# on a path that is already gone (QUIRKS.md), so withdrawing unconditionally costs a
# no-op in the case that used to be the only one handled.
#
# Still AFTER the rm above rather than before it: under `set -e` an rm that fails (a `uchg`
# flag, a read-only mount) would otherwise abort with the record already withdrawn, leaving
# a bundle still on disk, still runnable, and permanently unable to post a notification --
# and in the window between the two, any LaunchServices rescan re-registers exactly the
# record being removed. Dying after the rm instead leaves a stale record, which is no worse
# than never having run.
if ! is_throwaway_bundle_path "$APP_PATH" && [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -u "$APP_PATH" >/dev/null 2>&1 || true
fi
if [ -f "$LAUNCHER_STAMP_FILE" ]; then
  rm -f "$LAUNCHER_STAMP_FILE"
fi
# One checklist line for the whole step: the bundle, its LaunchServices record and its
# build stamp are three artefacts of the ONE thing install.sh's step 1b built, so they
# get one status line here rather than the three separate ==> lines they used to.
if [ "$LAUNCHER_BUNDLE_REMOVED" -eq 1 ]; then
  cbs_step_ok "launcher" "removed" "$APP_PATH"
else
  cbs_step_ok "launcher" "nothing to remove" "$APP_PATH"
fi

# --- 2. MCP registration -------------------------------------------------------
# After launchd, not before: once this script has already started tearing the
# daemon down, there is no reason to still be telling Claude Code to talk to it.
if "$MCP_CMD" mcp remove "$LABEL" --scope user >/dev/null 2>&1; then
  cbs_step_ok "mcp" "removed from claude"
else
  cbs_step_ok "mcp" "not registered"
fi

# --- 2b. the pomodoro timer's state and settings --------------------------------
# ADR.md entry 8: the daemon persists the whole pomodoro document -- timer state AND
# settings -- in ONE file beside the board store, $CLAUDE_BOARD_HOME/pomodoro.json.
# This is the one deliberate exception to "this script never writes to the store"
# (see the header comment above): a timer deadline and a break length are
# configuration this repo authored, not review history the user accumulated, so this
# script takes it back the same way it takes back the launcher bundle in step 1b.
#
# Removed by EXACT NAME, never `rm -rf "$STORE_DIR"` and never a glob -- STORE_DIR
# also holds boards/ and pages/, the user's actual review history, and those are
# named in the "left in place on purpose" summary below precisely so a mistake here
# would be a regression a check could catch, not a silent taste call.
POMODORO_FILE="$STORE_DIR/pomodoro.json"
if [ -f "$POMODORO_FILE" ]; then
  rm -f "$POMODORO_FILE"
  cbs_step_ok "pomodoro" "removed" "$POMODORO_FILE"
else
  cbs_step_ok "pomodoro" "no pomodoro state" "$POMODORO_FILE"
fi

# --- 2c. the manual ------------------------------------------------------------
# install.sh step 6 wrote ~/.claude/skills/claude-board/SKILL.md, so this script takes
# it back — the same rule the launcher bundle follows: what this repo installed, it
# removes. It is not the command file entry 5 forbids reaching into; that file was never
# ours, and this one is ours by definition (it is a copy of skills/claude-board/SKILL.md
# in the clone, and says so in its own first line).
#
# The directory goes only if the copy left it empty, so a `check.mjs` or a note the user
# put beside it survives.
if [ -f "$SKILL_FILE" ]; then
  rm -f "$SKILL_FILE"
  rmdir "$SKILL_DIR" 2>/dev/null || true
  cbs_step_ok "manual" "removed" "$SKILL_FILE"
else
  cbs_step_ok "manual" "not installed" "$SKILL_FILE"
fi

# --- 2d. a stale serve-root record, if an older install left one ---------------
# ADR.md entry 38: `/file/` and its allowlist are gone, so `$SECRET_DIR/serve_roots`
# is not an install-time CHOICE worth preserving the way ref_roots and board_home
# below are -- the thing it configured no longer exists, so keeping it around serves
# nobody. install.sh already deletes it on its own next run (next to the
# ref_roots/board_home persistence step), but a machine that goes straight from an
# old install to `git pull && ./uninstall.sh`, with no intervening `./install.sh`,
# would otherwise keep the file forever with nothing on screen naming it -- residue,
# not a preserved choice, so this script takes it back outright rather than listing
# it in the "left in place on purpose" summary below.
SERVE_ROOTS_RECORD_FILE="$SECRET_DIR/serve_roots"
if [ -f "$SERVE_ROOTS_RECORD_FILE" ]; then
  rm -f "$SERVE_ROOTS_RECORD_FILE"
  cbs_step_ok "cleanup" "removed stale serve_roots record" "$SERVE_ROOTS_RECORD_FILE"
fi
# Silent, not a "nothing to remove" checklist line, when there is nothing stale to
# report: unlike the six steps above, this one is not a standing part of every machine's
# teardown -- it only ever fires for a machine an old, pre-ADR-38 install left residue
# on. The ordinary case is that this file has never existed, and a tick line that has to
# name it just to say so would be exactly the noise this whole rework exists to cut.

# --- 3. report what is deliberately left behind --------------------------------
# The whole point of this section: an uninstall that silently destroyed a review
# archive would be a far worse bug than one that leaves too much. Name every path
# so the user can remove it by hand if they actually want it gone.
#
# Styled -- CBS_BOLD/CBS_DIM interpolated into each echoed string -- but not folded
# into the checklist above and not compressed into a pointer line the way install.sh's
# standing macOS prose is: this list is the one thing a person re-reads (see the spec
# decision this rework is built against), so it keeps every path, its own per-record
# loop, and both closing paragraphs in full. Built entirely from the fence's palette
# variables, same as every step line above, so a plain run drops the same colour and
# loses no information; kept as `echo` rather than the fence's own `printf` helpers
# because the settings.json paragraph below has to keep reading as an echoed message,
# not a file operation (see the check test/check-install.mjs runs against it).
echo
cbs_success "claude-board uninstalled"
echo
echo "  ${CBS_BOLD}left in place on purpose:${CBS_RESET}"
echo "     ${CBS_DIM}store (your review history):  $STORE_DIR${CBS_RESET}"
echo "     ${CBS_DIM}local secret:                 $SECRET_FILE${CBS_RESET}"
echo "     ${CBS_DIM}logs:                         $LOG_DIR${CBS_RESET}"
# The three carry-forward records, kept for the same reason the secret is: they are your
# configuration, not the bundle's. install.sh writes them so a reinstall keeps the roots,
# the store and the port you chose, now that the launcher bakes the first two in and the
# plist is rewritten from scratch on every run rather than read back. The launcher stamp
# above IS removed, because it describes a bundle that no longer exists; these describe
# choices that outlive it. Named
# individually rather than as "$SECRET_DIR/*" so nobody hand-deletes the secret with them.
# (`serve_roots` isn't named here: `/file/` and its allowlist are gone — ADR.md entry 38
# — and step 2d above removes any record an older install left, so there is nothing left
# for this summary to name.)
for record in "$SECRET_DIR/ref_roots" "$SECRET_DIR/board_home" "$SECRET_DIR/port"; do
  if [ -f "$record" ]; then
    echo "     ${CBS_DIM}install-time choice:          $record${CBS_RESET}"
  fi
done
echo
echo "  ${CBS_DIM}Remove them yourself if you want them gone.${CBS_RESET}"
echo
# Not in the list above, because it is not a path and not something to delete — but a
# user who granted a folder to an application that no longer exists is entitled to know
# the entry is still sitting in their settings.
echo "  ${CBS_DIM}One thing to tidy by hand if you want to: System Settings -> Privacy & Security ->${CBS_RESET}"
echo "  ${CBS_DIM}Files and Folders may still list '$LABEL'. The bundle it named is gone, so the${CBS_RESET}"
echo "  ${CBS_DIM}entry grants nothing; macOS offers no way for a script to remove it.${CBS_RESET}"
echo
# Named, not touched — same reason /grill is named in the header comment above rather
# than reached for: this script did not put it there, so it is the user's to remove.
echo "  ${CBS_DIM}Also not touched: the SessionStart hook snippet in ~/.claude/settings.json, if you${CBS_RESET}"
echo "  ${CBS_DIM}added the one INSTALL.md documents. This repo did not install it and this script${CBS_RESET}"
echo "  ${CBS_DIM}never reads or writes that file — remove the snippet yourself if you want it gone.${CBS_RESET}"
