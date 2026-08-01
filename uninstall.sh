#!/bin/bash
# uninstall.sh — the reverse of install.sh. Removes the two things install.sh puts
# outside this repository:
#
#   1. the launchd job (bootout) and its plist in ~/Library/LaunchAgents,
#   2. the MCP registration (`claude mcp remove --scope user`),
#   3. ~/Applications/claude-board.app, the launcher bundle, and the stamp that
#      records what it was built from.
#
# Order, and why: launchd first (bootout, then delete its plist) so nothing is
# actively supervised while the rest of the teardown runs. The MCP registration is
# next — once the daemon is on its way out, there is no reason to keep telling
# Claude Code to talk to it. The launcher bundle is last, since it is the binary
# the job was running and there is no reason to keep it once the job is gone.
#
# It does NOT remove `/grill` or any other command file (ADR.md entry 5): this
# repo no longer installs one, so it has nothing of its own to take back. Whatever
# a user has under ~/.claude/commands is theirs, versioned in their own repo on
# their own schedule — uninstalling the board must not reach into it.
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
#                                     (report only — this script never writes to it)
#   CLAUDE_BOARD_APP_DIR             default: ~/Applications
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

LABEL="claude-board"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
SECRET_DIR="$(dirname "$SECRET_FILE")"
APP_PATH="$APP_DIR/${LABEL}.app"
LAUNCHER_STAMP_FILE="$SECRET_DIR/launcher.stamp"

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
echo "Remove them yourself if you want them gone."
echo
# Not in the list above, because it is not a path and not something to delete — but a
# user who granted a folder to an application that no longer exists is entitled to know
# the entry is still sitting in their settings.
echo "One thing to tidy by hand if you want to: System Settings -> Privacy & Security ->"
echo "Files and Folders may still list '$LABEL'. The bundle it named is gone, so the"
echo "entry grants nothing; macOS offers no way for a script to remove it."
