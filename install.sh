#!/bin/bash
# install.sh — one idempotent command from a fresh clone of claude-board to a
# running service. Owns the three things that sit outside this repository (see
# DESIGN.md Decisions -> "One install command, because a clone is not
# enough"):
#
#   1. MCP registration (Claude Code owns the config): `claude mcp add
#      --scope user`, pointed at THIS clone's bin/mcp.mjs by absolute path.
#   2. The launchd plist in ~/Library/LaunchAgents, running THIS clone's
#      bin/daemon.mjs (PROTOCOL.md "Layout"), with RunAtLoad + KeepAlive, and
#      CLAUDE_BOARD_RELOAD_ON_CHANGE=1 in EnvironmentVariables so config sync
#      landing new code restarts the daemon. That env var, not a plist-level
#      WatchPaths, is what makes it work: WatchPaths only ever *starts* a job
#      that isn't running, and KeepAlive guarantees this one always already
#      is, so the two fight rather than compose. CLAUDE_BOARD_RELOAD_ON_CHANGE
#      makes the daemon itself watch src/ and bin/ and exit on a change —
#      KeepAlive is what brings it back, which DOES compose. See
#      bin/daemon.mjs and QUIRKS.md "WatchPaths does not restart the daemon".
#   3. The `/grill` command file, THIS clone's commands/grill.md, copied to
#      ~/.claude/commands/grill.md — the board's only caller (README "Use").
#      Without it a fresh clone yields a daemon and an MCP registration with no
#      way to reach either (SPEC_LAUNCH.md criterion 9).
#
# Running this script again on a machine that already has the service must
# change nothing and break nothing: no duplicate MCP registration, no
# duplicate launchd job, no clobbered logs, exit 0 both times. Reconciliation
# is unconditional remove-then-add / bootout-then-bootstrap rather than
# diffing prior state, so the result is the same regardless of what was there
# before (e.g. a stale registration pointing at a different clone path). The
# `/grill` command file is the one exception to "unconditional": it is
# overwritten only while the copy on disk is still the one install put there
# (see step 1 below) — a user's own edit is deliberately NOT unconditional.
#
# Testing seams (env vars): not user-facing configuration, defaults are the real
# paths, exist so test/check-install.mjs can point everything at a temp dir and a
# stub binary instead of touching this machine for real.
#
# CLAUDE_BOARD_HOME is NOT one of these. It is documented configuration — where the
# store lives — in README.md and PROTOCOL.md. This comment used to cite it as the
# example of a test seam, which is the description SPEC_LAUNCH.md criterion 15
# specifically retired.
#
#   CLAUDE_BOARD_LAUNCH_AGENTS_DIR   default: ~/Library/LaunchAgents
#   CLAUDE_BOARD_LOG_DIR             default: ~/Library/Logs/claude-board
#   CLAUDE_BOARD_MCP_CMD             default: claude
#   CLAUDE_BOARD_LAUNCHCTL_CMD       default: launchctl
#   CLAUDE_BOARD_PLUTIL_CMD          default: plutil
#   CLAUDE_BOARD_SECRET_FILE         default: ~/.config/claude-board/secret
#   CLAUDE_BOARD_COMMANDS_DIR        default: ~/.claude/commands
#
# macOS only, zero dependencies: bash + coreutils + launchctl/plutil, nothing
# this OS doesn't already ship.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_PATH="$REPO_DIR/bin/daemon.mjs"
MCP_PATH="$REPO_DIR/bin/mcp.mjs"
GRILL_SRC="$REPO_DIR/commands/grill.md"

MCP_CMD="${CLAUDE_BOARD_MCP_CMD:-claude}"
LAUNCHCTL_CMD="${CLAUDE_BOARD_LAUNCHCTL_CMD:-launchctl}"
PLUTIL_CMD="${CLAUDE_BOARD_PLUTIL_CMD:-plutil}"
LAUNCH_AGENTS_DIR="${CLAUDE_BOARD_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${CLAUDE_BOARD_LOG_DIR:-$HOME/Library/Logs/claude-board}"
PORT="${CLAUDE_BOARD_PORT:-7391}"
SECRET_FILE="${CLAUDE_BOARD_SECRET_FILE:-$HOME/.config/claude-board/secret}"
COMMANDS_DIR="${CLAUDE_BOARD_COMMANDS_DIR:-$HOME/.claude/commands}"

# The plist's Label MUST be exactly this: the shim's unreachable-daemon
# message (bin/mcp.mjs) tells users `launchctl kickstart -k
# gui/$(id -u)/claude-board`, and that command only works if the label
# matches.
LABEL="claude-board"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
OUT_LOG="$LOG_DIR/daemon.out.log"
ERR_LOG="$LOG_DIR/daemon.err.log"
COMMAND_FILE="$COMMANDS_DIR/grill.md"

echo "==> claude-board install"
echo "    repo:   $REPO_DIR"
echo "    daemon: $DAEMON_PATH"
echo "    mcp:    $MCP_PATH"

if [ ! -f "$DAEMON_PATH" ] || [ ! -f "$MCP_PATH" ] || [ ! -f "$GRILL_SRC" ]; then
  echo "error: bin/daemon.mjs, bin/mcp.mjs or commands/grill.md not found under $REPO_DIR — run this script from a claude-board clone" >&2
  exit 1
fi

# The interpreter path is baked into the plist and into the MCP registration, so it
# has to still exist in six months. `command -v node` alone does not clear that bar on
# a machine using nvm: it resolves to ~/.nvm/versions/node/v24.18.0/bin/node, and the
# next `nvm install` leaves launchd pointing at a directory that is gone — a daemon
# that will not start, reported as "daemon is not reachable" in every session. A
# version-manager path is therefore only used when there is no stable alternative, and
# the substitution is announced rather than silent. CLAUDE_BOARD_NODE overrides both.
NODE_BIN="${CLAUDE_BOARD_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
  case "$NODE_BIN" in
    */.nvm/*|*/.fnm/*|*/.volta/*|*/.asdf/*|*/n/versions/*)
      for stable in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
        if [ -x "$stable" ]; then
          echo "==> note: node on PATH is version-managed ($NODE_BIN), which moves on upgrade;"
          echo "    baking $stable into the plist instead (set CLAUDE_BOARD_NODE to override)"
          NODE_BIN="$stable"
          break
        fi
      done
      if [ "$NODE_BIN" = "$(command -v node || true)" ]; then
        echo "==> warning: only a version-managed node was found ($NODE_BIN)."
        echo "    The service will break the next time that version is removed; re-run this"
        echo "    script after installing node system-wide, or set CLAUDE_BOARD_NODE."
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

# --- 0. the local secret ----------------------------------------------------
# The credential that tells this machine's shim from any other local process
# (DESIGN.md Decisions -> "A loopback Host check, an origin check, and a
# local secret"; SPEC_LAUNCH.md -> "Read routes are gated"). The daemon requires
# it on every route but /api/health -- reads included, since the cookie a browser
# holds is derived from this file -- and bin/mcp.mjs reads it at startup and sends
# it. /api/health stays open precisely so the health check below can use plain
# curl, which has no credential to offer.
#
# Generated FIRST, before launchd is (re)loaded, so the daemon that comes up
# below already has one to read.
#
# Idempotent in the strongest sense: an existing secret is NEVER rotated.
# Rotating it would 401 every shim already running against the old value —
# i.e. every live Claude Code session on this machine would lose the board
# mid-review — and re-running install.sh is a routine, expected act (config
# sync, a moved clone, a repeat of the README's one command).
SECRET_DIR="$(dirname "$SECRET_FILE")"
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"
if [ -s "$SECRET_FILE" ]; then
  echo "==> local secret already present at $SECRET_FILE (left as it is; never rotated)"
else
  # crypto.randomBytes, i.e. the OS CSPRNG, 32 bytes rendered as 64 hex chars.
  # Written through a 077 umask so it is never briefly world-readable between
  # creation and chmod, and chmod'ed anyway so a pre-existing empty file with
  # looser modes is corrected rather than trusted.
  ( umask 077; "$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$SECRET_FILE" )
  chmod 600 "$SECRET_FILE"
  echo "==> generated local secret at $SECRET_FILE"
fi

# --- 1. the /grill command file ---------------------------------------------
# ~/.claude/commands/grill.md is the board's only caller (README "Use") — without
# it a fresh clone yields a daemon and an MCP registration with no way to reach
# either. Idempotent, but not the same "unconditional" idempotence as the rest of
# this script: a routine reinstall legitimately needs to OVERWRITE this file to
# ship a fix, but a user who edited their own copy did it on purpose, and losing
# that edit to a routine reinstall is exactly the failure SPEC_LAUNCH.md criterion
# 9 exists to prevent. So the file is overwritten only when the copy on disk is
# still the one install put there; a genuinely different copy is left alone, and
# the rest of install still runs rather than dying here.
#
# "Still the one install put there" is decided by evidence, not by hope: a sha256
# of whatever install last wrote is recorded in HASH_FILE, kept beside the local
# secret ($SECRET_DIR is already 0700, already holds one machine credential, so a
# hash of a public file needs no seam of its own — it rides along with
# CLAUDE_BOARD_SECRET_FILE). The file on disk counts as unmodified iff its own
# hash matches that record, OR it is already byte-identical to the copy this run
# would install anyway — the latter covers a fresh clone with no record yet, and
# a plain no-op reinstall.
HASH_FILE="$SECRET_DIR/grill.sha256"

sha256_file() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}

mkdir -p "$COMMANDS_DIR"
SHIPPED_HASH="$(sha256_file "$GRILL_SRC")"

if [ ! -f "$COMMAND_FILE" ]; then
  cp "$GRILL_SRC" "$COMMAND_FILE"
  echo "$SHIPPED_HASH" > "$HASH_FILE"
  echo "==> installed $COMMAND_FILE"
else
  INSTALLED_HASH="$(sha256_file "$COMMAND_FILE")"
  RECORDED_HASH=""
  if [ -f "$HASH_FILE" ]; then
    RECORDED_HASH="$(cat "$HASH_FILE")"
  fi
  if [ "$INSTALLED_HASH" = "$SHIPPED_HASH" ]; then
    # Already exactly what this run would install (fresh clone with no record
    # yet, or a plain no-op reinstall) — keep the record fresh and move on.
    echo "$SHIPPED_HASH" > "$HASH_FILE"
    echo "==> $COMMAND_FILE already up to date"
  elif [ -n "$RECORDED_HASH" ] && [ "$INSTALLED_HASH" = "$RECORDED_HASH" ]; then
    # Unmodified since the last install: this is how a user gets fixes.
    cp "$GRILL_SRC" "$COMMAND_FILE"
    echo "$SHIPPED_HASH" > "$HASH_FILE"
    echo "==> updated $COMMAND_FILE"
  else
    echo "==> $COMMAND_FILE has local edits — leaving it as is"
    echo "    shipped copy: $GRILL_SRC"
    echo "    to take the update anyway (this overwrites your edits): cp \"$GRILL_SRC\" \"$COMMAND_FILE\""
  fi
fi

# --- 2. launchd plist -------------------------------------------------------
# The launchd half runs BEFORE the MCP registration, deliberately. The
# registration is a remove-then-add on config this repo does not own; if a
# launchctl step fails afterwards under `set -e`, the script dies having
# already torn down and rebuilt that registration, i.e. it can only ever
# strand the half it does not own. Doing the part this repo owns first means
# a failure leaves the previous registration exactly as it was.
mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$LOG_DIR"
# The logs carry whatever the daemon prints about boards, i.e. the user's own
# questions and answers; same owner-only posture as the store itself.
chmod 700 "$LOG_DIR"

# Every value below is spliced into XML, and a clone path is a filename: `&`, `<`
# and `>` are all legal in one. Unescaped, a path containing `&` produces a plist
# that plutil rejects while this script still exits 0 and launchd silently has
# nothing to load.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# bin/daemon.mjs itself watches src/ and bin/ when CLAUDE_BOARD_RELOAD_ON_CHANGE=1 (set
# below) and exits on a change there — never on the clone root, so an edit to
# DESIGN.md, findings/ or a scratch file does not cost a
# restart. A restart mid-review drops every SSE stream and every held-open wait, which
# then has to reattach, so the daemon's own watch is deliberately narrower than "the
# whole clone" for the same reason a plist-level WatchPaths would have been.
LABEL_X="$(xml_escape "$LABEL")"
NODE_BIN_X="$(xml_escape "$NODE_BIN")"
DAEMON_PATH_X="$(xml_escape "$DAEMON_PATH")"
REPO_DIR_X="$(xml_escape "$REPO_DIR")"
OUT_LOG_X="$(xml_escape "$OUT_LOG")"
ERR_LOG_X="$(xml_escape "$ERR_LOG")"
PORT_X="$(xml_escape "$PORT")"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL_X}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${NODE_BIN_X}</string>
		<string>${DAEMON_PATH_X}</string>
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
		<key>CLAUDE_BOARD_RELOAD_ON_CHANGE</key>
		<string>1</string>
	</dict>
</dict>
</plist>
PLIST

# Refuse to report success on a plist launchd cannot load. Without this an
# unparseable plist is invisible: bootstrap fails, the script exits 0 anyway, and
# the user is told the service is running.
if ! "$PLUTIL_CMD" -lint "$PLIST_PATH" >/dev/null; then
  echo "error: generated plist at $PLIST_PATH is not valid — refusing to continue" >&2
  exit 1
fi

echo "==> wrote $PLIST_PATH"

# --- 3. load / reload it, idempotently --------------------------------------
# bootout-then-bootstrap rather than a conditional check: idempotent either
# way (bootout of a job that isn't loaded just fails, harmlessly, so a fresh
# machine and a reinstall take the same path) and it's what actually picks up
# a plist that changed (e.g. a different clone path) rather than restarting
# the previously-loaded definition in place.
#
# Every launchctl call is guarded rather than left to `set -e`, because the
# common reinstall path genuinely fails once: bootout returns as soon as the
# job is asked to stop, while a KeepAlive job is still tearing down, and a
# bootstrap landing in that window is refused ("service already loaded" /
# EBUSY). Retrying is the fix; dying is not. Whether the service actually came
# up is settled by the health check below, not by these exit codes.
UID_N="$(id -u)"
DOMAIN="gui/${UID_N}"
TARGET="${DOMAIN}/${LABEL}"

echo "==> loading service ($LAUNCHCTL_CMD)"
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
  echo "error: launchctl bootstrap $TARGET kept failing — the previous job may still be running" >&2
  echo "       try: launchctl bootout $TARGET && bash $0" >&2
  exit 1
fi

"$LAUNCHCTL_CMD" enable "$TARGET" >/dev/null 2>&1 || true
"$LAUNCHCTL_CMD" kickstart -k "$TARGET" >/dev/null 2>&1 || true

# --- 4. prove it actually bound before claiming success ----------------------
# "wrote a plist and called launchctl" is not "running": a syntax error in the
# daemon, a port already taken, or a bootstrap that silently did nothing all
# end here otherwise, with the script cheerfully printing "installed and
# running".
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
echo "==> waiting for $HEALTH_URL"
HEALTHY=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 0.25
done
if [ "$HEALTHY" -ne 1 ]; then
  echo "error: the daemon never answered $HEALTH_URL — it is NOT running" >&2
  echo "       logs: $OUT_LOG" >&2
  echo "             $ERR_LOG" >&2
  exit 1
fi

# --- 5. MCP registration ---------------------------------------------------
# Claude Code owns this config, not this repo. Reconcile unconditionally:
# remove any prior registration under this name (no-op, ignored, if there
# isn't one — e.g. a fresh machine, or a stale one from a different clone
# path) then add one pointing at this clone. That is what keeps a second run
# from duplicating a registration or erroring on one that's already there.
# Last, so that nothing above can fail with this half-rewritten.
echo "==> registering MCP server '$LABEL' ($MCP_CMD)"
"$MCP_CMD" mcp remove "$LABEL" --scope user >/dev/null 2>&1 || true
if ! "$MCP_CMD" mcp add "$LABEL" --scope user -- "$NODE_BIN" "$MCP_PATH"; then
  echo "error: '$MCP_CMD mcp add' failed — the daemon is running, but Claude Code has no" >&2
  echo "       registration for it. Re-run this script once that command works." >&2
  exit 1
fi

echo
echo "claude-board installed and running."
echo
echo "verify:  curl -s http://127.0.0.1:${PORT}/api/health"
# Boards are served only to an authorized browser. The tab a session opens is
# authorized for you; this is the one command for a browser that holds nothing
# (cleared cookies, a second profile, a different browser), and it is the same
# command the daemon's own refusal page prints.
echo "authorize a browser:  $NODE_BIN $REPO_DIR/bin/authorize.mjs"
# Deliberately the literal string bin/mcp.mjs prints on an unreachable daemon
# (gui/\$(id -u), not the resolved uid) — same command, same shell semantics,
# copy-pasteable either place it's printed.
echo 'revive:  launchctl kickstart -k gui/$(id -u)/claude-board'
echo "command: $COMMAND_FILE"
echo "logs:    $OUT_LOG"
echo "         $ERR_LOG"
