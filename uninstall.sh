#!/bin/bash
# uninstall.sh — the reverse of install.sh. Removes the two things install.sh puts
# outside this repository:
#
#   1. the launchd job (bootout) and its plist in ~/Library/LaunchAgents,
#   2. the MCP registration (`claude mcp remove --scope user`),
#   3. ~/Applications/claude-board.app, the launcher bundle, and the stamp that
#      records what it was built from,
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
# (ADR.md entry 38). Unlike ref_roots/board_home below, this is not a choice worth
# keeping: the thing it configured no longer exists, so it is taken back outright
# rather than named in the "left in place on purpose" summary. See step 2d.
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
#   CLAUDE_BOARD_HOME                default: ~/Library/Application Support/claude-board
#                                     (this script removes exactly one file inside it —
#                                     $CLAUDE_BOARD_HOME/pomodoro.json, by exact name,
#                                     see step 2b — and otherwise only reports the path;
#                                     boards/ and pages/ are never touched)
#   CLAUDE_BOARD_APP_DIR             default: ~/Applications
#   CLAUDE_BOARD_SKILLS_DIR          default: ~/.claude/skills
#
# macOS only, zero dependencies: bash + coreutils + launchctl, nothing this OS
# doesn't already ship.

set -euo pipefail

MCP_CMD="${CLAUDE_BOARD_MCP_CMD:-claude}"
LAUNCHCTL_CMD="${CLAUDE_BOARD_LAUNCHCTL_CMD:-launchctl}"
LAUNCH_AGENTS_DIR="${CLAUDE_BOARD_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${CLAUDE_BOARD_LOG_DIR:-$HOME/Library/Logs/claude-board}"
SECRET_FILE="${CLAUDE_BOARD_SECRET_FILE:-$HOME/.config/claude-board/secret}"
STORE_DIR="${CLAUDE_BOARD_HOME:-$HOME/Library/Application Support/claude-board}"

APP_DIR="${CLAUDE_BOARD_APP_DIR:-$HOME/Applications}"
SKILLS_DIR="${CLAUDE_BOARD_SKILLS_DIR:-$HOME/.claude/skills}"

LABEL="claude-board"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
SECRET_DIR="$(dirname "$SECRET_FILE")"
APP_PATH="$APP_DIR/${LABEL}.app"
LAUNCHER_STAMP_FILE="$SECRET_DIR/launcher.stamp"
SKILL_DIR="$SKILLS_DIR/${LABEL}"
SKILL_FILE="$SKILL_DIR/SKILL.md"

echo "==> claude-board uninstall"

# --- 1. launchd: stop the job, then remove its plist --------------------------
UID_N="$(id -u)"
DOMAIN="gui/${UID_N}"
TARGET="${DOMAIN}/${LABEL}"

if "$LAUNCHCTL_CMD" bootout "$TARGET" >/dev/null 2>&1; then
  echo "==> stopped the launchd job ($TARGET)"
else
  # Normal, not fatal: the exact same fact install.sh's own reinstall path
  # already relies on — bootout of a job that isn't loaded just fails harmlessly.
  # Covers "never installed" and "already uninstalled" identically.
  echo "==> no running launchd job to stop ($TARGET)"
fi

if [ -f "$PLIST_PATH" ]; then
  rm -f "$PLIST_PATH"
  echo "==> removed $PLIST_PATH"
else
  echo "==> no plist at $PLIST_PATH"
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
if [ -d "$APP_PATH" ]; then
  rm -rf "$APP_PATH"
  echo "==> removed $APP_PATH"
else
  echo "==> no launcher bundle at $APP_PATH"
fi
if [ -f "$LAUNCHER_STAMP_FILE" ]; then
  rm -f "$LAUNCHER_STAMP_FILE"
  echo "==> removed $LAUNCHER_STAMP_FILE (the record of what that bundle was built from)"
fi

# --- 2. MCP registration -------------------------------------------------------
# After launchd, not before: once this script has already started tearing the
# daemon down, there is no reason to still be telling Claude Code to talk to it.
if "$MCP_CMD" mcp remove "$LABEL" --scope user >/dev/null 2>&1; then
  echo "==> removed the MCP registration ($MCP_CMD mcp remove $LABEL --scope user)"
else
  echo "==> no MCP registration for '$LABEL' to remove"
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
  echo "==> removed $POMODORO_FILE"
else
  echo "==> no pomodoro state at $POMODORO_FILE"
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
  echo "==> removed $SKILL_FILE"
else
  echo "==> no board manual at $SKILL_FILE"
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
  echo "==> removed $SERVE_ROOTS_RECORD_FILE (a leftover from before /file/ was deleted -- ADR.md entry 38)"
fi

# --- 3. report what is deliberately left behind --------------------------------
# The whole point of this section: an uninstall that silently destroyed a review
# archive would be a far worse bug than one that leaves too much. Name every path
# so the user can remove it by hand if they actually want it gone.
echo
echo "claude-board uninstalled."
echo
echo "left in place on purpose:"
echo "  store (your review history):  $STORE_DIR"
echo "  local secret:                 $SECRET_FILE"
echo "  logs:                         $LOG_DIR"
# The two carry-forward records, kept for the same reason the secret is: they are your
# configuration, not the bundle's. install.sh writes them so a reinstall keeps the roots
# and store you chose, now that the launcher bakes those in and the plist no longer
# carries them to be read back. The launcher stamp above IS removed, because it describes
# a bundle that no longer exists; these describe choices that outlive it. Named
# individually rather than as "$SECRET_DIR/*" so nobody hand-deletes the secret with them.
# (`serve_roots` isn't named here: `/file/` and its allowlist are gone — ADR.md entry 38
# — and step 2d above removes any record an older install left, so there is nothing left
# for this summary to name.)
for record in "$SECRET_DIR/ref_roots" "$SECRET_DIR/board_home"; do
  if [ -f "$record" ]; then
    echo "  install-time choice:          $record"
  fi
done
echo "Remove them yourself if you want them gone."
echo
# Not in the list above, because it is not a path and not something to delete — but a
# user who granted a folder to an application that no longer exists is entitled to know
# the entry is still sitting in their settings.
echo "One thing to tidy by hand if you want to: System Settings -> Privacy & Security ->"
echo "Files and Folders may still list '$LABEL'. The bundle it named is gone, so the"
echo "entry grants nothing; macOS offers no way for a script to remove it."
echo
# Named, not touched — same reason /grill is named in the header comment above rather
# than reached for: this script did not put it there, so it is the user's to remove.
echo "Also not touched: the SessionStart hook snippet in ~/.claude/settings.json, if you"
echo "added the one INSTALL.md documents. This repo did not install it and this script"
echo "never reads or writes that file — remove the snippet yourself if you want it gone."
