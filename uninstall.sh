#!/bin/bash
# uninstall.sh — the reverse of install.sh. Removes the three things install.sh puts
# outside this repository (SPEC_LAUNCH.md criterion 11):
#
#   1. the launchd job (bootout) and its plist in ~/Library/LaunchAgents,
#   2. the MCP registration (`claude mcp remove --scope user`),
#   3. the installed `/grill` command file — unless it has been edited since
#      install put it there, in which case it is the user's file and is left
#      alone, same rule install.sh itself follows on the way in.
#
# Order, and why: launchd first (bootout, then delete its plist) so nothing is
# actively supervised while the rest of the teardown runs. The MCP registration is
# next — once the daemon is on its way out, there is no reason to keep telling
# Claude Code to talk to it. The command file is last, because deciding whether to
# touch it takes a real check (unmodified vs. user-edited) rather than an
# unconditional remove, and doing it last means every other removal has already
# finished by the time that check runs, regardless of what it decides.
#
# Three things are left ON PURPOSE and named by path in the summary this script
# prints at the end: the store (the user's review history), the local secret, and
# the logs. Deleting any of those silently would be a worse bug than leaving too
# much — this is the same judgment call as install.sh never rotating an existing
# secret, just pointed the other way.
#
# Safe to run when nothing is installed: a bootout of a job that was never loaded,
# an `mcp remove` of a registration that was never added, and an `rm` of a plist or
# command file that was never written all fail harmlessly rather than aborting the
# script, so a machine install.sh never touched still gets exit 0. Safe to run
# twice for the same reason — the second run just finds nothing left to remove.
#
# Testing seams (env vars) — identical meaning to install.sh's, so a check can point
# both scripts at the very same temp dir:
#
#   CLAUDE_BOARD_LAUNCH_AGENTS_DIR   default: ~/Library/LaunchAgents
#   CLAUDE_BOARD_LOG_DIR             default: ~/Library/Logs/claude-board (report only)
#   CLAUDE_BOARD_MCP_CMD             default: claude
#   CLAUDE_BOARD_LAUNCHCTL_CMD       default: launchctl
#   CLAUDE_BOARD_SECRET_FILE         default: ~/.config/claude-board/secret (report
#                                     only; also where the command-file hash record
#                                     lives, beside the secret — see install.sh)
#   CLAUDE_BOARD_COMMANDS_DIR        default: ~/.claude/commands
#   CLAUDE_BOARD_HOME                default: ~/Library/Application Support/claude-board
#                                     (report only — this script never writes to it)
#
# macOS only, zero dependencies: bash + coreutils + launchctl, nothing this OS
# doesn't already ship.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
GRILL_SRC="$REPO_DIR/commands/grill.md"

MCP_CMD="${CLAUDE_BOARD_MCP_CMD:-claude}"
LAUNCHCTL_CMD="${CLAUDE_BOARD_LAUNCHCTL_CMD:-launchctl}"
LAUNCH_AGENTS_DIR="${CLAUDE_BOARD_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${CLAUDE_BOARD_LOG_DIR:-$HOME/Library/Logs/claude-board}"
SECRET_FILE="${CLAUDE_BOARD_SECRET_FILE:-$HOME/.config/claude-board/secret}"
COMMANDS_DIR="${CLAUDE_BOARD_COMMANDS_DIR:-$HOME/.claude/commands}"
STORE_DIR="${CLAUDE_BOARD_HOME:-$HOME/Library/Application Support/claude-board}"

LABEL="claude-board"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
COMMAND_FILE="$COMMANDS_DIR/grill.md"
SECRET_DIR="$(dirname "$SECRET_FILE")"
HASH_FILE="$SECRET_DIR/grill.sha256"

# A working node is needed only to hash the command file for the modified-vs-not
# check below — never baked into anything durable, so none of install.sh's
# version-manager care applies here. Any node on PATH (or CLAUDE_BOARD_NODE) does.
NODE_BIN="${CLAUDE_BOARD_NODE:-$(command -v node || true)}"

sha256_file() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}

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

# --- 2. MCP registration -------------------------------------------------------
# After launchd, not before: once this script has already started tearing the
# daemon down, there is no reason to still be telling Claude Code to talk to it.
if "$MCP_CMD" mcp remove "$LABEL" --scope user >/dev/null 2>&1; then
  echo "==> removed the MCP registration ($MCP_CMD mcp remove $LABEL --scope user)"
else
  echo "==> no MCP registration for '$LABEL' to remove"
fi

# --- 3. the installed /grill command file --------------------------------------
# Same evidence-based rule as install.sh's own step 1, run in reverse: a file that
# still matches the hash install recorded (or still matches this clone's own
# shipped copy) is safe to delete. Anything else is the user's edit, and this
# script is exactly as careful about destroying it on the way out as install.sh
# is about overwriting it on the way in (SPEC_LAUNCH.md criterion 11).
if [ ! -f "$COMMAND_FILE" ]; then
  echo "==> no command file at $COMMAND_FILE"
elif [ -z "$NODE_BIN" ]; then
  # No node on PATH to hash with: refuse to guess, leave the file, say why.
  echo "==> $COMMAND_FILE left in place (no node on PATH to verify it is unmodified)"
else
  INSTALLED_HASH="$(sha256_file "$COMMAND_FILE")"
  RECORDED_HASH=""
  if [ -f "$HASH_FILE" ]; then
    RECORDED_HASH="$(cat "$HASH_FILE")"
  fi
  SHIPPED_HASH=""
  if [ -f "$GRILL_SRC" ]; then
    SHIPPED_HASH="$(sha256_file "$GRILL_SRC")"
  fi

  UNMODIFIED=0
  if [ -n "$RECORDED_HASH" ] && [ "$INSTALLED_HASH" = "$RECORDED_HASH" ]; then UNMODIFIED=1; fi
  if [ -n "$SHIPPED_HASH" ] && [ "$INSTALLED_HASH" = "$SHIPPED_HASH" ]; then UNMODIFIED=1; fi

  if [ "$UNMODIFIED" -eq 1 ]; then
    rm -f "$COMMAND_FILE"
    rm -f "$HASH_FILE"
    echo "==> removed $COMMAND_FILE"
  else
    echo "==> $COMMAND_FILE has local edits — leaving it (it is your file, not this repo's)"
    echo "    remove it yourself if you want it gone: rm \"$COMMAND_FILE\""
  fi
fi

# --- 4. report what is deliberately left behind --------------------------------
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
