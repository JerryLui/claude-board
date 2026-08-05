#!/bin/bash
# install.sh — one idempotent command from a fresh clone of claude-board to a
# running service. Owns the two things that sit outside this repository (see
# DESIGN.md Decisions -> "One install command, because a clone is not
# enough"):
#
#   1. MCP registration (Claude Code owns the config): `claude mcp add
#      --scope user`, pointed at THIS clone's bin/mcp.mjs by absolute path.
#   1b. ~/Applications/claude-board.app, a launcher bundle compiled from
#      bin/launcher.c and ad-hoc signed, which exists so macOS TCC has an
#      application to attribute the daemon's file reads to. Without it the plist
#      runs `node` directly, TCC has only `node` to ask about, and every
#      reference into ~/Documents, ~/Desktop or ~/Downloads comes back EPERM.
#      This step also stages a COPY of bin/daemon.mjs and all of src/ into the
#      bundle's Contents/Resources, ahead of the codesign call, so the signature
#      (and the rebuild stamp) cover the code that runs under the granted
#      identity, not just the launcher binary that forks it. See step 1b below
#      and SECURITY.md "What the launcher bundle is for".
#   2. The launchd plist in ~/Library/LaunchAgents, running the daemon (PROTOCOL.md
#      "Layout") through that launcher — from the COPY staged in the bundle when a
#      launcher is in use, or straight from THIS clone's bin/daemon.mjs on the
#      degraded (no-launcher) path — with RunAtLoad + KeepAlive. New code does NOT
#      restart the daemon by itself:
#      this script's own bootout/bootstrap at the end is what takes an update,
#      so a running review is never interrupted by somebody's save. (A
#      plist-level WatchPaths could not have done it anyway — it only ever
#      *starts* a job that isn't running, and KeepAlive guarantees this one
#      always already is, so the two fight rather than compose; see QUIRKS.md
#      "WatchPaths does not restart the daemon".)
#      The dict carries CLAUDE_BOARD_PORT and, on the DEGRADED (no-launcher) path only,
#      CLAUDE_BOARD_REF_ROOTS/SERVE_ROOTS/HOME too: a launchd job inherits nothing from
#      your shell, so any knob the daemon reads from the environment has to be written
#      here or it may as well not exist. With a launcher bundle in use, those three are
#      baked into the bundle instead (step 1b, bin/launcher.c) and deliberately left out
#      of this dict — see "the plist stops carrying what the launcher now bakes" at step
#      2, and SECURITY.md "Known limits of that..." / "Fixed 2026-08-04: the environment
#      used to be a third route, and the widest one".
#
# Plus one file, added in step 6 below: skills/claude-board/SKILL.md, the manual
# for the `ask` tool, copied to ~/.claude/skills/claude-board/.
#
# That is the whole boundary (ADR.md entries 5 and 11): this script installs the
# service, its credential and the manual for its one tool, and nothing that
# calls them. `/grill` and every other caller are personal, versioned in
# ~/.claude's own git repo, and evolve on their own schedule — a fresh clone
# yields a daemon, an MCP registration and a manual, and pointing something at
# them is a separate, later act.
#
# Running this script again on a machine that already has the service must
# change nothing and break nothing: no duplicate MCP registration, no
# duplicate launchd job, no clobbered logs, exit 0 both times. Reconciliation
# is unconditional remove-then-add / bootout-then-bootstrap rather than
# diffing prior state, so the result is the same regardless of what was there
# before (e.g. a stale registration pointing at a different clone path).
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
#   CLAUDE_BOARD_APP_DIR             default: ~/Applications
#   CLAUDE_BOARD_CC                  default: cc
#   CLAUDE_BOARD_CODESIGN            default: codesign
#   CLAUDE_BOARD_SKILLS_DIR          default: ~/.claude/skills
#
# macOS only, zero dependencies: bash + coreutils + launchctl/plutil, nothing
# this OS doesn't already ship — with one soft dependency, the `cc` from the
# Xcode Command Line Tools, needed only to build the launcher bundle. A machine
# without it still gets a working install (step 1b degrades to running node
# directly, exactly as every version before the bundle did); what it does not get
# is the ability to read a board reference out of ~/Documents, ~/Desktop or
# ~/Downloads. That is a loud warning, not a failure.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_PATH="$REPO_DIR/bin/daemon.mjs"
MCP_PATH="$REPO_DIR/bin/mcp.mjs"

MCP_CMD="${CLAUDE_BOARD_MCP_CMD:-claude}"
LAUNCHCTL_CMD="${CLAUDE_BOARD_LAUNCHCTL_CMD:-launchctl}"
PLUTIL_CMD="${CLAUDE_BOARD_PLUTIL_CMD:-plutil}"
LAUNCH_AGENTS_DIR="${CLAUDE_BOARD_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${CLAUDE_BOARD_LOG_DIR:-$HOME/Library/Logs/claude-board}"
PORT="${CLAUDE_BOARD_PORT:-7391}"
SECRET_FILE="${CLAUDE_BOARD_SECRET_FILE:-$HOME/.config/claude-board/secret}"
APP_DIR="${CLAUDE_BOARD_APP_DIR:-$HOME/Applications}"
CC_CMD="${CLAUDE_BOARD_CC:-cc}"
CODESIGN_CMD="${CLAUDE_BOARD_CODESIGN:-codesign}"
SKILLS_DIR="${CLAUDE_BOARD_SKILLS_DIR:-$HOME/.claude/skills}"
SKILL_SRC="$REPO_DIR/skills/claude-board/SKILL.md"
SKILL_DEST_DIR="$SKILLS_DIR/claude-board"

# Needed before the roots/store resolution just below, which now carries a previous
# choice forward by reading it back from here rather than from the plist -- see that
# resolution's comments and "Carry-forward across reinstalls" further down. The
# directory itself is created (0700) in step 0; these three are just its filenames,
# alongside the secret and the launcher build stamp it already holds.
SECRET_DIR="$(dirname "$SECRET_FILE")"
REF_ROOTS_RECORD_FILE="$SECRET_DIR/ref_roots"
SERVE_ROOTS_RECORD_FILE="$SECRET_DIR/serve_roots"
BOARD_HOME_RECORD_FILE="$SECRET_DIR/board_home"

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
# The bundle's icon, and therefore the icon on every pomodoro notification. Generated from
# the board mark in src/styles.mjs, which is the same mark the favicon draws, by:
#   rsvg-convert -w N -h N mark.svg -o icon_NxN.png   (N = 16,32,64,128,256,512,1024)
#   iconutil -c icns -o bin/claude-board.icns claude-board.iconset
# Checked in rather than generated here: rsvg-convert is a homebrew package, and an
# install must not need one. Treated as optional below for the same reason a missing C
# compiler is — an unbrandable bundle is worth more than no bundle.
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

# The allowlist a content reference may resolve inside, on top of the board's own
# project directory (ADR.md entry 3, src/resolve.mjs): colon-separated absolute paths,
# so a session can render the skill, command or agent file it is discussing.
#
# The default is three directories, NOT ~/.claude as a whole (audit S1, 2026-07-31):
# the rest of that tree is settings.json, .credentials.json, shell snapshots and every
# project's transcripts, none of which a board has a reason to quote.
# `CLAUDE_BOARD_REF_ROOTS=$HOME/.claude ./install.sh` still installs the whole tree for
# anyone who wants it. Keep these three in step with DEFAULT_REF_ROOTS in
# src/resolve.mjs; test/check-install.mjs asserts they match.
#
# This is also the ONLY place the default exists (audit S3): src/resolve.mjs reads an
# absent CLAUDE_BOARD_REF_ROOTS as an EMPTY allowlist, so that a default living in code
# cannot widen the boundary on machines whose plist predates it — the daemon restarts
# itself on any src/ change, so such a default would go live during a `git pull`,
# unannounced. Written here, the default arrives when someone runs the installer, which
# is a thing a person does deliberately.
#
# Which leaves the upgrade path, and it used to leak the same way (audit NEW-2): this
# script rewrote the plist unconditionally and never read the old one back, so an
# operator who ran `CLAUDE_BOARD_REF_ROOTS= ./install.sh` to get a cwd-only daemon had
# that decision reverted to the default by the next `git pull && ./install.sh` from a
# clean shell — the boundary widening back with nothing on screen. So the precedence is:
# an explicit variable wins (empty included), otherwise whatever was carried forward
# says (originally the plist; now $REF_ROOTS_RECORD_FILE, next to the secret — see
# "Carry-forward across reinstalls" below and the resolution just under this comment),
# and only a machine with neither at all gets the default. The resolved value is printed
# either way, so it is never a silent choice. The consequence worth naming: a machine
# that still says `~/.claude` from before the narrowing keeps it until someone says
# otherwise. That is the safe direction of the two — an upgrade may not widen what an
# operator narrowed, and it may not narrow what they widened either, because both are
# their call and not this script's.
DEFAULT_REF_ROOTS="$HOME/.claude/skills:$HOME/.claude/commands:$HOME/.claude/agents"
if [ -n "${CLAUDE_BOARD_REF_ROOTS+set}" ]; then
  REF_ROOTS="$CLAUDE_BOARD_REF_ROOTS"
  REF_ROOTS_FROM="CLAUDE_BOARD_REF_ROOTS"
elif [ -f "$REF_ROOTS_RECORD_FILE" ]; then
  # The ordinary carry-forward path once a launcher bundle is in use: the plist no
  # longer carries this value at all (see "the plist stops carrying..." at step 2 below),
  # so this file -- rewritten at the end of every run that resolves a value, right after
  # the secret above is created -- is what a plain `git pull && ./install.sh` reads back
  # instead of the plist.
  REF_ROOTS="$(cat "$REF_ROOTS_RECORD_FILE")"
  REF_ROOTS_FROM="carried forward from $REF_ROOTS_RECORD_FILE"
elif REF_ROOTS="$("$PLUTIL_CMD" -extract EnvironmentVariables.CLAUDE_BOARD_REF_ROOTS raw -o - "$PLIST_PATH" 2>/dev/null)"; then
  # One-time migration fallback, for a plist from before the record file existed -- back
  # when the plist itself was the only carry-forward mechanism there was. Exit 0 means
  # the key was there, empty string included -- which is exactly the value that must
  # survive an upgrade, since it is the one that narrows. Written into the record file
  # below, so this branch fires at most once per machine.
  REF_ROOTS_FROM="carried forward from $PLIST_PATH (migrated to $REF_ROOTS_RECORD_FILE)"
else
  REF_ROOTS="$DEFAULT_REF_ROOTS"
  REF_ROOTS_FROM="default"
fi

# CLAUDE_BOARD_SERVE_ROOTS: where `GET /file/<path>` may read from. Resolved with the
# same precedence as the reference roots above, and for the same reasons — an explicit
# variable wins (empty included), otherwise the installed plist is carried forward, and
# only a machine with no plist gets the default. src/resolve.mjs reads an absent value as
# an empty allowlist, i.e. the route is off, so the default lives here and nowhere else.
#
# It is a SEPARATE variable from the reference roots, deliberately, and the difference is
# a real escalation rather than bookkeeping: a referenced file is escaped into a board
# block, while a served file is a live document at the daemon's own origin. Sharing one
# list would have turned every existing install's reference roots into serve roots on the
# next `git pull`, which is precisely the silent widening the paragraph above refuses.
#
# The default is the one directory the render skills write into. A machine without it
# installs fine and serves nothing: src/resolve.mjs drops a root that does not exist,
# rather than failing the install or widening to its parent.
DEFAULT_SERVE_ROOTS="$HOME/Documents/renders"
if [ -n "${CLAUDE_BOARD_SERVE_ROOTS+set}" ]; then
  SERVE_ROOTS="$CLAUDE_BOARD_SERVE_ROOTS"
  SERVE_ROOTS_FROM="CLAUDE_BOARD_SERVE_ROOTS"
elif [ -f "$SERVE_ROOTS_RECORD_FILE" ]; then
  # Same carry-forward replacement as CLAUDE_BOARD_REF_ROOTS above, and for the same
  # reason: the plist stops carrying this once a launcher bundle is in use.
  SERVE_ROOTS="$(cat "$SERVE_ROOTS_RECORD_FILE")"
  SERVE_ROOTS_FROM="carried forward from $SERVE_ROOTS_RECORD_FILE"
elif SERVE_ROOTS="$("$PLUTIL_CMD" -extract EnvironmentVariables.CLAUDE_BOARD_SERVE_ROOTS raw -o - "$PLIST_PATH" 2>/dev/null)"; then
  # One-time migration fallback -- see the identical branch on CLAUDE_BOARD_REF_ROOTS.
  SERVE_ROOTS_FROM="carried forward from $PLIST_PATH (migrated to $SERVE_ROOTS_RECORD_FILE)"
else
  SERVE_ROOTS="$DEFAULT_SERVE_ROOTS"
  SERVE_ROOTS_FROM="default"
fi

# CLAUDE_BOARD_HOME, resolved the same way and for the same reason (audit). It is
# documented configuration (README.md, PROTOCOL.md), but it was never written into
# the plist -- and a launchd job inherits nothing from the shell that ran this
# script, so pointing the store at an encrypted volume produced a green install and
# boards at the default path anyway. Unlike REF_ROOTS there is no default to write:
# absent means the key is omitted and src/store.mjs picks its own default, so an
# install that never set it keeps exactly today's plist.
if [ -n "${CLAUDE_BOARD_HOME+set}" ]; then
  BOARD_HOME="$CLAUDE_BOARD_HOME"
  BOARD_HOME_FROM="CLAUDE_BOARD_HOME"
elif [ -f "$BOARD_HOME_RECORD_FILE" ]; then
  # Same carry-forward replacement as the two roots above. Unlike them there is no
  # default to fall back to below this -- BOARD_HOME_FROM empty means "the operator
  # never chose one", and that has to stay distinguishable from "chose the default
  # explicitly" for the plist logic further down (BOARD_HOME_XML) to keep working.
  BOARD_HOME="$(cat "$BOARD_HOME_RECORD_FILE")"
  BOARD_HOME_FROM="carried forward from $BOARD_HOME_RECORD_FILE"
elif BOARD_HOME="$("$PLUTIL_CMD" -extract EnvironmentVariables.CLAUDE_BOARD_HOME raw -o - "$PLIST_PATH" 2>/dev/null)"; then
  # One-time migration fallback -- see the identical branch on CLAUDE_BOARD_REF_ROOTS.
  BOARD_HOME_FROM="carried forward from $PLIST_PATH (migrated to $BOARD_HOME_RECORD_FILE)"
else
  BOARD_HOME=""
  BOARD_HOME_FROM=""
fi

# The launcher's compiled-in CLAUDE_BOARD_STORE_DIR (bin/launcher.c) always has to be a
# real path -- it is baked in and applied unconditionally, so an empty string would just
# mean the daemon spends a run resolving its own fallback anyway, and "the header states
# nothing" is exactly the silence the resolved-value-on-screen rule elsewhere in this
# script refuses. So: the operator's choice if there is one, otherwise the identical
# default src/store.mjs would compute on its own (kept in step with it here, the way
# DEFAULT_REF_ROOTS is kept in step with src/resolve.mjs).
if [ -n "$BOARD_HOME_FROM" ]; then
  EFFECTIVE_BOARD_HOME="$BOARD_HOME"
else
  EFFECTIVE_BOARD_HOME="$HOME/Library/Application Support/claude-board"
fi

echo "==> claude-board install"
echo "    repo:   $REPO_DIR"
echo "    daemon: $DAEMON_PATH"
echo "    mcp:    $MCP_PATH"
# Spelled out rather than folded into a ${REF_ROOTS:-...} default: an apostrophe inside
# that word is a quote character to bash even within double quotes, which silently
# swallows the rest of the script up to the next one. See QUIRKS.md.
if [ -n "$REF_ROOTS" ]; then
  echo "    reference roots: $REF_ROOTS"
else
  echo "    reference roots: none (a reference resolves inside the board project directory only)"
fi
echo "                     [$REF_ROOTS_FROM]"
if [ -n "$SERVE_ROOTS" ]; then
  echo "    serve roots:     $SERVE_ROOTS"
else
  echo "    serve roots:     none (/file serves nothing)"
fi
echo "                     [$SERVE_ROOTS_FROM]"
# Printed for the same reason the roots are: the store is where the reviewer's answers
# end up, and an operator who redirected it should be able to see that it took.
if [ -n "$BOARD_HOME_FROM" ]; then
  echo "    store:  $BOARD_HOME"
  echo "                     [$BOARD_HOME_FROM]"
else
  echo "    store:  ~/Library/Application Support/claude-board [default]"
fi

if [ ! -f "$DAEMON_PATH" ] || [ ! -f "$MCP_PATH" ] || [ ! -f "$LAUNCHER_SRC" ] || [ ! -d "$REPO_DIR/src" ]; then
  echo "error: bin/daemon.mjs, bin/mcp.mjs, bin/launcher.c or src/ not found under $REPO_DIR — run this script from a claude-board clone" >&2
  exit 1
fi
# src/ is staged into the launcher bundle whole (step 1b below), so it has to exist even on
# the degraded (no-launcher) path -- a clone missing it is not a partial install, it is one
# bin/daemon.mjs's own `../src/server.mjs` import could never have satisfied either.

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

# Persist the resolved roots (and the store, if the operator chose one) into the same
# 0700 directory, so the NEXT run's resolution above reads them back from here instead
# of from the plist -- which, once a launcher bundle is in use, no longer carries them
# at all (see "the plist stops carrying..." at step 2 below). Roots are rewritten every
# run regardless of where the value came from, default included: today's default is
# tomorrow's carried-forward value, the same way the plist always held the key
# regardless of value under the old mechanism. The store is the odd one out, as it is
# everywhere else in this script -- written only when the operator has actually chosen
# one, so an install that never mentions CLAUDE_BOARD_HOME keeps resolving the daemon's
# own default rather than freezing today's default in as a future explicit choice.
printf '%s' "$REF_ROOTS" > "$REF_ROOTS_RECORD_FILE"
printf '%s' "$SERVE_ROOTS" > "$SERVE_ROOTS_RECORD_FILE"
if [ -n "$BOARD_HOME_FROM" ]; then
  printf '%s' "$BOARD_HOME" > "$BOARD_HOME_RECORD_FILE"
else
  rm -f "$BOARD_HOME_RECORD_FILE"
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

# The same digest over a string rather than a file, used by step 1b to fold several
# file hashes and an identifier into the one stamp that decides whether the launcher
# bundle needs rebuilding. Callers keep the argument ASCII (digests and an identifier,
# never a raw path), because a process argument reaches node as a UTF-8 string and a
# filename is not obliged to be one.
sha256_string() {
  "$NODE_BIN" -e '
    const crypto = require("node:crypto");
    process.stdout.write(crypto.createHash("sha256").update(process.argv[1], "utf8").digest("hex"));
  ' "$1"
}

# The digest of the daemon's own payload -- bin/daemon.mjs and everything under src/ --
# folded into the launcher stamp below so that editing either in THE CLONE (not the
# installed bundle, which is a copy made at build time and already covered by
# codesign) makes the next install rebuild rather than report "already current" over
# stale code. One node invocation for the whole tree rather than one sha256_file call
# per file: this already runs on every install, including a no-op one, since the stamp
# has to be computed before it can be compared.
#
# Deterministic by construction, which the brief this exists for calls out by name:
# `readdirSync` order is not documented as stable, so every relative path is collected
# first and sorted before anything is hashed, and the digest is built from each file's
# OWN hash paired with its relative path (not from concatenating raw file bytes back to
# back), so content never depends on mtime, inode, or the order the filesystem happened
# to hand files back in -- two clean checkouts of identical content produce the same
# digest. See test/check-install-payload.mjs, which pins this against a real filesystem
# rather than trusting the reasoning.
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
# Two destinations, two rules, and a clone path is a filename in both: it may legally
# contain any byte but NUL and `/`.
#
# LC_ALL=C on both, because a filename is bytes and a locale is an opinion about them
# (audit S9, 2026-07-31). Under a UTF-8 locale BSD sed refuses input that is not valid
# UTF-8 with "RE error: illegal byte sequence" and exits non-zero — and under `set -euo
# pipefail` that failing command substitution aborts the entire install, part-way
# through, on a clone path or a reference root containing one stray byte. In the C locale
# sed treats the input as bytes and passes it through untouched, which is what a
# substitution over a handful of ASCII characters wanted all along.

# For XML: `&`, `<` and `>` are all legal in a filename. Unescaped, a path containing `&`
# produces a plist that plutil rejects while this script still exits 0 and launchd
# silently has nothing to load.
xml_escape() {
  printf '%s' "$1" | LC_ALL=C sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# For a C string literal in the generated launcher_paths.h: a backslash or a double quote
# in a clone path would otherwise end the literal early and turn a path into a syntax
# error, or worse, into a different path. Order matters — backslashes first, or the
# backslash this function just added to escape a quote gets escaped in turn.
#
# A newline cannot be escaped this way (sed is line-oriented, and the substitution would
# have to span lines), so it is refused by the caller instead rather than silently
# producing a header that will not compile.
c_escape() {
  printf '%s' "$1" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# --- 1b. the launcher app bundle --------------------------------------------
# What this is for, in one line: macOS TCC gates ~/Documents, ~/Desktop and ~/Downloads
# per application, and "the application" here is whatever the plist names. Naming
# `node` means the only grant that unblocks a board is a grant to every node program on
# the machine — and one that dies at the next `brew upgrade node`, since homebrew's node
# is ad-hoc signed under a versioned Cellar path. So the plist names a bundle of ours
# instead: ~/Applications/claude-board.app, compiled from bin/launcher.c, ad-hoc signed
# under $BUNDLE_ID, which forks the real node. See bin/launcher.c for why it forks
# rather than execs, and SECURITY.md for what the grant does and does not widen.
#
# The user still has to tick the box once; nothing here can grant anything. What this
# step owes them is that they are asked ONCE. TCC pins a grant to the code signature, so
# a rebuild resets it and the user gets silently locked out again by an install that
# landed nothing but JavaScript — which, given install.sh is the routine way to take an
# update, would be most installs. Hence the stamp: the bundle is rebuilt only when one of
# its actual inputs changed (the launcher source, either baked-in path, the bundle
# identifier), and a run that would produce the same bundle touches nothing at all.
#
# The bundle's signature used to cover only the launcher binary — bin/daemon.mjs and all
# of src/, the code that actually runs under the granted identity, stayed in the clone,
# outside the signature and outside the stamp. Anything that could write the clone owned
# the grant with no recompile and no re-sign (SECURITY.md "Known limits of that"). Fixed
# here: the build below copies bin/daemon.mjs and src/ into $STAGED_APP/Contents/Resources
# BEFORE codesign runs, so the ad-hoc signature — and codesign --verify, already part of
# the "already current" test — cover the payload too, and a digest of that payload
# (payload_digest, above) is folded into the stamp so editing it in the clone forces a
# rebuild instead of being silently ignored. bin/daemon.mjs's own `../src/server.mjs`
# import resolves unchanged, because the copy preserves bin/'s and src/'s relative layout.
# mcp.mjs, authorize.mjs and launcher.c are deliberately NOT copied: the first two are the
# shim, registered with Claude Code and invoked by callers at this clone's own absolute
# path, never through the launcher or the TCC-granted identity, so a copy inside the
# bundle would be dead weight nothing points at; the third is a build input, not something
# ever executed as itself.
LAUNCHER_STAMP_FILE="$SECRET_DIR/launcher.stamp"
USE_LAUNCHER=0
# Only a bundle built by THIS run earns the "grant it in System Settings" notice at the
# end. A reinstall that left an already-granted bundle alone must not tell the user to go
# and grant it again, or the notice stops meaning anything.
LAUNCHER_IS_NEW=0

launcher_degraded() {
  echo "==> warning: $1."
  echo "    Installing WITHOUT the launcher bundle: the daemon runs as node itself, so a"
  echo "    board reference into ~/Documents, ~/Desktop or ~/Downloads will fail with"
  echo "    'cannot read <path>: EPERM' — macOS has no application of ours to grant."
  echo "    Everything else works. To fix: xcode-select --install, then re-run this script."
}

# bin/launcher.c includes its generated header with a QUOTED #include
# ("launcher_paths.h", not <launcher_paths.h>), and a quoted include searches the
# including file's own directory first. Compiling bin/launcher.c in place, out of the
# clone, means that search starts in bin/ — so a launcher_paths.h planted there shadows
# the real one this script generates and gets baked into a bundle macOS will trust with
# the Documents grant, with nothing on screen saying so. Below, the source is copied
# into $LAUNCHER_BUILD_DIR next to the real header and compiled from there instead, with
# no include path back into the clone (-iquote, not -I): a quoted include's own-directory
# search then lands on the real header no matter what sits beside bin/launcher.c. That
# makes the shadow powerless by construction rather than by a check that could rot, but a
# leftover header at this path is still worth naming — an older install.sh generated it
# in place, so it is plausible and innocent, and refusing outright would turn a stale
# file into a failed install.
if [ -f "$REPO_DIR/bin/launcher_paths.h" ]; then
  echo "==> warning: ignoring $REPO_DIR/bin/launcher_paths.h — the launcher is compiled from a copy staged outside the clone, so this file cannot affect the built bundle."
fi

LAUNCHER_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-board-launcher.XXXXXX")"
trap 'rm -rf "$LAUNCHER_BUILD_DIR"' EXIT

STAGED_APP="$LAUNCHER_BUILD_DIR/${LABEL}.app"
STAGED_INFO="$STAGED_APP/Contents/Info.plist"
STAGED_HEADER="$LAUNCHER_BUILD_DIR/launcher_paths.h"
# The compiled copy of bin/launcher.c, staged beside STAGED_HEADER for the reason above.
STAGED_LAUNCHER_SRC="$LAUNCHER_BUILD_DIR/launcher.c"
# bin/notify.m gets the same treatment for consistency rather than necessity: it includes
# nothing of ours, so there is no header for anything beside it in the clone to shadow.
# Compiling both halves of the binary out of the same staging directory is one fewer rule
# to remember than compiling one there and one from the clone.
STAGED_NOTIFY_SRC="$LAUNCHER_BUILD_DIR/notify.m"
mkdir -p "$STAGED_APP/Contents/MacOS"
cp "$LAUNCHER_SRC" "$STAGED_LAUNCHER_SRC"
cp "$LAUNCHER_NOTIFY_SRC" "$STAGED_NOTIFY_SRC"

# The one filename byte c_escape cannot handle. Absurd in practice, a broken build if it
# ever happens, and cheaper to refuse by name than to debug from a compiler error.
# BUNDLED_DAEMON_PATH and REPO_DIR are checked alongside DAEMON_PATH because both are
# baked into the header below too (BUNDLED_DAEMON_PATH as CLAUDE_BOARD_DAEMON, REPO_DIR
# as CLAUDE_BOARD_REPO_ROOT_VALUE).
case "$NODE_BIN$DAEMON_PATH$BUNDLED_DAEMON_PATH$REPO_DIR" in
  *$'\n'*) LAUNCHER_NEWLINE_IN_PATH=1 ;;
  *) LAUNCHER_NEWLINE_IN_PATH=0 ;;
esac

if [ "$LAUNCHER_NEWLINE_IN_PATH" -eq 1 ]; then
  launcher_degraded "the node or daemon path contains a newline, which cannot be baked into the launcher"
else
  PAYLOAD_DIGEST="$(payload_digest "$REPO_DIR")"
  cat > "$STAGED_HEADER" <<HEADER
/* Generated by install.sh — not checked in, rebuilt from scratch on every run.
 * CLAUDE_BOARD_NODE and CLAUDE_BOARD_DAEMON are the only two things bin/launcher.c will
 * ever execute, deliberately: see the header comment there for why the target is
 * compiled in rather than read from argv. CLAUDE_BOARD_DAEMON here is the path INSIDE
 * the bundle (Contents/Resources/bin/daemon.mjs) now that install.sh stages the daemon's
 * own code there — see "the launcher app bundle" above — not the clone's bin/daemon.mjs.
 * The six below them are the environment that exec gets — HOME, PATH, the three
 * CLAUDE_BOARD_* variables that decide what the daemon may read, serve and write, and
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
#define CLAUDE_BOARD_SERVE_ROOTS_VALUE "$(c_escape "$SERVE_ROOTS")"
#define CLAUDE_BOARD_REPO_ROOT_VALUE "$(c_escape "$REPO_DIR")"
HEADER

  # CFBundleIconFile only when there is an icon to name, because naming one that is not in
  # Contents/Resources is worse than naming none: the bundle then has a broken icon
  # reference rather than the system default. The key is spliced in ahead of the first
  # key below (trailing newline inside the variable, no blank line when empty) so that the
  # plist stays byte-identical to the pre-icon one on an install that has no icns —
  # a plist whose bytes moved is a rebuild, and a rebuild is the user's Documents grant.
  ICON_PLIST_ENTRY=""
  if [ -f "$LAUNCHER_ICON_SRC" ]; then
    ICON_PLIST_ENTRY="	<key>CFBundleIconFile</key>
	<string>$(xml_escape "$LABEL")</string>
"
  fi

  # LSBackgroundOnly, because this is a daemon: without it the launcher takes a Dock
  # icon and a menu bar at login. It does NOT stop the bundle posting notifications, and
  # does not stop macOS showing the one-time "claude-board would like to send you
  # notifications" prompt — measured, not assumed (QUIRKS.md). No CFBundleVersion tied to
  # package.json's version either — a version bump would change these bytes, change the
  # signature, and cost the user their Documents grant for nothing. The bundle's version
  # is the bundle's, and it only moves when the bundle actually does.
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
	<key>LSBackgroundOnly</key>
	<true/>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
</dict>
</plist>
INFO

  # Every input that decides the bundle's bytes, and nothing that does not. Composed out
  # of hex digests and an ASCII identifier rather than out of the paths themselves, so
  # this string is safe to hand to node as an argument no matter what bytes the clone
  # path is made of. PAYLOAD_DIGEST (computed above, before this script knew whether it
  # would even reach this branch — the stamp has to be computed to be COMPARED) is what
  # makes an edit to bin/daemon.mjs or anything under src/ in the clone force a rebuild:
  # without it, the payload copied into Contents/Resources a few lines below could go
  # stale forever, since nothing else in this stamp depends on its content.
  # The icon is a bundle input like any other, so it is in the stamp like any other: a
  # redrawn icns with everything else unchanged has to force a rebuild, or the bundle
  # keeps the old art forever. "none" rather than a digest when there is no icns, so that
  # adding one later moves the stamp too.
  LAUNCHER_ICON_DIGEST="none"
  if [ -f "$LAUNCHER_ICON_SRC" ]; then
    LAUNCHER_ICON_DIGEST="$(sha256_file "$LAUNCHER_ICON_SRC")"
  fi
  LAUNCHER_STAMP="$(sha256_string "$(sha256_file "$LAUNCHER_SRC")|$(sha256_file "$LAUNCHER_NOTIFY_SRC")|$LAUNCHER_ICON_DIGEST|$(sha256_file "$STAGED_HEADER")|$(sha256_file "$STAGED_INFO")|$BUNDLE_ID|$PAYLOAD_DIGEST")"

  # The stamp file has two lines: the input stamp above, and the sha256 of the
  # executable as it was actually installed (recorded below, after the atomic `mv`).
  # The first covers everything that DECIDES the bundle's bytes; the second covers the
  # bytes themselves, so that editing the installed binary directly -- bypassing every
  # input above -- still makes the next run rebuild rather than trust a stamp that no
  # longer describes what is on disk. A stamp file written by an older install.sh has
  # only the first line: the second read is then empty, which can never equal a real
  # digest, so that case rebuilds once rather than crashing on a missing field.
  RECORDED_LAUNCHER_STAMP=""
  RECORDED_EXEC_STAMP=""
  if [ -f "$LAUNCHER_STAMP_FILE" ]; then
    RECORDED_LAUNCHER_STAMP="$(sed -n '1p' "$LAUNCHER_STAMP_FILE")"
    RECORDED_EXEC_STAMP="$(sed -n '2p' "$LAUNCHER_STAMP_FILE")"
  fi

  # "Already current" has to mean the bundle on disk is really there, really signed, and
  # really the bytes the stamp describes -- not just that a stamp file says so: the app
  # lives in ~/Applications, where a user is entitled to drag things to the Trash or
  # overwrite the executable in place, and a stamp that outlived what it was stamping
  # would otherwise leave the plist pointing at something wrong, or a tampered binary
  # mistaken for the one this script built.
  if [ -n "$RECORDED_LAUNCHER_STAMP" ] && [ "$RECORDED_LAUNCHER_STAMP" = "$LAUNCHER_STAMP" ] \
     && [ -x "$APP_EXEC" ] && [ -n "$RECORDED_EXEC_STAMP" ] \
     && [ "$RECORDED_EXEC_STAMP" = "$(sha256_file "$APP_EXEC")" ] \
     && "$CODESIGN_CMD" --verify "$APP_PATH" >/dev/null 2>&1; then
    USE_LAUNCHER=1
    echo "==> launcher bundle already current at $APP_PATH (untouched, so its Documents grant survives)"
  elif ! command -v "$CC_CMD" >/dev/null 2>&1; then
    launcher_degraded "no C compiler ('$CC_CMD') found — the Xcode Command Line Tools are not installed"
  elif ! command -v "$CODESIGN_CMD" >/dev/null 2>&1; then
    launcher_degraded "no '$CODESIGN_CMD' found, so the launcher bundle cannot be signed"
  # -Wall but not -Werror: a future compiler inventing a new warning must not be able to
  # turn a routine reinstall into a failed one. -iquote, not -I: the source compiled here
  # is the copy staged next to the real header (see STAGED_LAUNCHER_SRC above), and no
  # include path reaches back into the clone, so a launcher_paths.h planted beside
  # bin/launcher.c has no route into this build.
  # Two compiler invocations rather than one, because the two halves are different
  # languages: -fobjc-arc is meaningless for C and passing it alongside a .c file makes
  # clang say so. notify.m compiles to an object first, then launcher.c compiles and links
  # against it with the two frameworks UNUserNotificationCenter needs. Both halves land in
  # one binary on purpose — see bin/notify.m's header for why a second executable in the
  # bundle cannot post a notification.
  elif ! {
    "$CC_CMD" -O2 -Wall -fobjc-arc -c -o "$LAUNCHER_BUILD_DIR/notify.o" "$STAGED_NOTIFY_SRC" 2>&1 \
      && "$CC_CMD" -O2 -Wall -o "$STAGED_APP/Contents/MacOS/$LABEL" \
           -iquote "$LAUNCHER_BUILD_DIR" "$STAGED_LAUNCHER_SRC" "$LAUNCHER_BUILD_DIR/notify.o" \
           -framework Foundation -framework UserNotifications 2>&1
  }; then
    launcher_degraded "the launcher failed to compile (output above)"
  # The daemon's own payload, staged into Contents/Resources BEFORE signing so the
  # ad-hoc signature (and codesign --verify, part of the "already current" test above)
  # cover it too — see "the launcher app bundle" comment near the top of this step.
  # mkdir -p first, then cp -R with a trailing "/." on the source and a trailing "/" on
  # the already-created destination: explicit rather than relying on cp -R's own
  # directory-exists-or-not behaviour, which differs depending on whether Resources/src
  # already exists (it never does here, since $STAGED_APP is fresh out of mktemp, but the
  # explicit form is correct either way and does not depend on that being true forever).
  # The icon rides along in the same step and under the same signature: it is what every
  # pomodoro notification shows, and CFBundleIconFile above names it. Copied only if it
  # exists, matching the plist key above — a clone with no icns builds an unbranded bundle
  # rather than no bundle.
  elif ! {
    mkdir -p "$STAGED_APP/Contents/Resources/bin" "$STAGED_APP/Contents/Resources/src" \
      && cp "$REPO_DIR/bin/daemon.mjs" "$STAGED_APP/Contents/Resources/bin/daemon.mjs" \
      && cp -R "$REPO_DIR/src/." "$STAGED_APP/Contents/Resources/src/" \
      && { [ ! -f "$LAUNCHER_ICON_SRC" ] || cp "$LAUNCHER_ICON_SRC" "$STAGED_APP/Contents/Resources/${LABEL}.icns"; }
  }; then
    launcher_degraded "could not stage bin/daemon.mjs and src/ into the bundle before signing"
  # --force so a re-sign replaces rather than refuses; --identifier explicitly rather
  # than inherited from Info.plist, because this string IS the grant's name and it should
  # be impossible to change it by editing a plist alone.
  elif ! "$CODESIGN_CMD" --force --sign - --identifier "$BUNDLE_ID" "$STAGED_APP" 2>&1; then
    launcher_degraded "the launcher bundle failed to sign (output above)"
  elif ! "$CODESIGN_CMD" --verify "$STAGED_APP" >/dev/null 2>&1; then
    launcher_degraded "the launcher bundle did not verify after signing"
  else
    mkdir -p "$APP_DIR"
    # Signed in the staging directory and swapped in whole, so a compile or sign that
    # fails leaves the previously installed bundle exactly as it was — including, and
    # this is the point, its grant. Removing the old bundle while the current daemon is
    # running from it is safe: the running image holds its inode open, and it is being
    # booted out and replaced twenty lines below anyway.
    rm -rf "$APP_PATH"
    mv "$STAGED_APP" "$APP_PATH"
    # The second field is hashed AFTER the mv, i.e. of the executable exactly as
    # installed at $APP_EXEC -- not the staged copy -- so the recorded digest is the one
    # a future run will actually find on disk.
    printf '%s\n%s\n' "$LAUNCHER_STAMP" "$(sha256_file "$APP_EXEC")" > "$LAUNCHER_STAMP_FILE"
    USE_LAUNCHER=1
    echo "==> built and signed $APP_PATH ($BUNDLE_ID)"
    LAUNCHER_IS_NEW=1
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

# Every value below is spliced into XML by xml_escape, defined above step 1b (with
# c_escape, its C-string counterpart) because the launcher bundle's Info.plist needs it
# first. The reasoning lives with the function.

# No reload-on-change key here, and none in bin/daemon.mjs either: a daemon that exits
# on every write under src/ restarts mid-review, and a restart drops every SSE stream
# and every held-open wait, which then has to reattach. Taking an update is this
# script's job (the bootout/bootstrap below), at a moment somebody chose.
LABEL_X="$(xml_escape "$LABEL")"
NODE_BIN_X="$(xml_escape "$NODE_BIN")"
DAEMON_PATH_X="$(xml_escape "$DAEMON_PATH")"
APP_EXEC_X="$(xml_escape "$APP_EXEC")"
REPO_DIR_X="$(xml_escape "$REPO_DIR")"
OUT_LOG_X="$(xml_escape "$OUT_LOG")"
ERR_LOG_X="$(xml_escape "$ERR_LOG")"
PORT_X="$(xml_escape "$PORT")"

# What launchd actually execs, and therefore what TCC will attribute every file the
# daemon reads to. The launcher takes no arguments on purpose (bin/launcher.c: the target
# is compiled in, so holding the Documents grant is not the same as being able to point
# it at arbitrary code), which is why this is one string where the fallback is two.
if [ "$USE_LAUNCHER" -eq 1 ]; then
  PROGRAM_ARGS_XML="		<string>${APP_EXEC_X}</string>"
else
  PROGRAM_ARGS_XML="		<string>${NODE_BIN_X}</string>
		<string>${DAEMON_PATH_X}</string>"
fi

# CLAUDE_BOARD_REF_ROOTS, CLAUDE_BOARD_SERVE_ROOTS and CLAUDE_BOARD_HOME: written into
# this dict only on the DEGRADED path. When a launcher bundle is in use it bakes all
# three into itself instead (step 1b above, bin/launcher.c's OVERRIDE_ENV) and ignores
# whatever this dict says for them — so leaving them here too would be a second copy of
# a decision the plist no longer makes, and one that reads as though rewriting the plist
# could still move the boundary when it cannot. Without a launcher, node runs directly
# and reads its environment from here because there is nowhere else for it to come from,
# so the degraded plist carries exactly what it always did: every value below is
# unconditional in that branch, same as before this change, because src/resolve.mjs
# reads an absent key as no allowlist at all rather than as "ask the launcher".
if [ "$USE_LAUNCHER" -eq 1 ]; then
  EXTRA_ENV_XML=""
else
  REF_ROOTS_X="$(xml_escape "$REF_ROOTS")"
  SERVE_ROOTS_X="$(xml_escape "$SERVE_ROOTS")"
  EXTRA_ENV_XML="		<key>CLAUDE_BOARD_REF_ROOTS</key>
		<string>${REF_ROOTS_X}</string>
		<key>CLAUDE_BOARD_SERVE_ROOTS</key>
		<string>${SERVE_ROOTS_X}</string>
"
  # Emitted only when the operator actually chose a store root, so a degraded install
  # that never mentions CLAUDE_BOARD_HOME produces a byte-identical dict to before and
  # the daemon keeps picking its own default.
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
${EXTRA_ENV_XML}	</dict>
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

# A launcher bundle built by THIS run has no TCC grant yet, and if this clone sits in
# ~/Documents, ~/Desktop or ~/Downloads then reading bin/daemon.mjs is itself a gated
# read: the daemon cannot start until the user allows it. macOS raises that prompt
# against the launchd job, so it appears while this loop is waiting — which is why the
# budget below is a person's budget rather than a process's. Five seconds is plenty for
# a daemon and nowhere near enough for a dialog nobody has looked at yet.
case "$REPO_DIR/" in
  "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*) REPO_IN_PROTECTED_DIR=1 ;;
  *) REPO_IN_PROTECTED_DIR=0 ;;
esac

HEALTH_TRIES=20
if [ "$LAUNCHER_IS_NEW" -eq 1 ] && [ "$REPO_IN_PROTECTED_DIR" -eq 1 ]; then
  HEALTH_TRIES=480   # 0.25s apart, i.e. two minutes to notice a dialog and click it
  echo
  echo "==> macOS will now ask whether \"$LABEL\" may access files in your"
  echo "    $(dirname "$REPO_DIR") folder. Click Allow — this clone lives there, so the"
  echo "    daemon cannot read its own code until you do."
  echo "    If no dialog appears: System Settings -> Privacy & Security -> Files and Folders,"
  echo "    find $LABEL, and turn the folder on there."
  echo
fi

echo "==> waiting for $HEALTH_URL"
HEALTHY=0
for _ in $(seq 1 "$HEALTH_TRIES"); do
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
  # The one failure mode this script can name precisely rather than leave to the logs,
  # because the logs say "EPERM" and mean "you have not clicked Allow yet".
  if [ "$USE_LAUNCHER" -eq 1 ] && [ "$REPO_IN_PROTECTED_DIR" -eq 1 ]; then
    echo >&2
    echo "       Most likely cause: macOS is refusing $LABEL access to $(dirname "$REPO_DIR")," >&2
    echo "       which is where this clone lives, so the daemon cannot read its own code." >&2
    echo "       Fix it in System Settings -> Privacy & Security -> Files and Folders (find" >&2
    echo "       $LABEL), then: launchctl kickstart -k $TARGET" >&2
  fi
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

# --- 6. The manual ---------------------------------------------------------
# skills/claude-board/SKILL.md copied to ~/.claude/skills/claude-board/, which is
# where Claude Code looks for a personal skill. This is not a caller (ADR.md entry 5,
# amended by entry 11): it teaches the `ask` tool's call shape, block kinds, widgets,
# packet and failure modes, and decides nothing about when to ask. Callers name it and
# keep only what is specific to them, so the protocol has one statement instead of one
# per caller.
#
# Unconditional overwrite, no hash record and no did-they-edit-it branch — the machinery
# entry 5 deleted along with the old command-file step. The file is this repo's, says so
# in its own first line, and a copy that quietly stops matching the shim is the whole
# failure this step exists to prevent. Non-fatal: a daemon and a registration are the
# install, and a missing manual must not fail a run that produced both.
echo "==> installing the board's manual to $SKILL_DEST_DIR/SKILL.md"
if [ ! -f "$SKILL_SRC" ]; then
  echo "warning: $SKILL_SRC is missing — skills that name the claude-board skill will not" >&2
  echo "         find it. The daemon and the MCP registration are unaffected." >&2
elif ! (mkdir -p "$SKILL_DEST_DIR" && cp "$SKILL_SRC" "$SKILL_DEST_DIR/SKILL.md"); then
  echo "warning: could not write $SKILL_DEST_DIR/SKILL.md. The daemon and the MCP" >&2
  echo "         registration are unaffected." >&2
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
echo "logs:    $OUT_LOG"
echo "         $ERR_LOG"
# LaunchServices has to know about the bundle before macOS will let it post a
# notification at all -- a bundle that is merely present at $APP_PATH, correctly signed
# and perfectly runnable, is refused with "Notifications are not allowed for this
# application" until it is registered. LaunchServices does pick up ~/Applications on its
# own eventually, but "eventually" is not something the first pomodoro boundary after an
# install can wait for. Measured, and recorded in QUIRKS.md.
#
# lsregister lives at a private path, which is why this is a guarded call and not a
# dependency: if Apple moves it, the bundle is registered a little later by the scanner
# instead of immediately by this line, and nothing else about the install changes.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ "$USE_LAUNCHER" -eq 1 ] && [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP_PATH" >/dev/null 2>&1 || true
fi

# Ask for notification permission here, at the end of an install the reader is watching,
# rather than leaving the prompt to surface hours later at the first pomodoro boundary --
# by which time the dialog has no context and the interval it belonged to is already
# running. `|| true` because this script runs under `set -e` and a reader who says No (or
# who has said No before) has answered the question, not broken the install: notifications
# are one feature of the board and the daemon above is already up and serving without
# them. Idempotent on every later run — macOS prompts once per bundle and answers from its
# own record after that, so this is a no-op round trip on an install that changed nothing.
if [ "$USE_LAUNCHER" -eq 1 ] && [ -x "$APP_EXEC" ]; then
  # Said before the call, not after: the first install puts a dialog on screen and this
  # line blocks until it is answered, and an unexplained pause with a dialog behind the
  # terminal window is the shape of a hung installer. Every later run prints this and
  # returns instantly, which is the price of not having to know in advance which run is
  # the first one.
  echo "==> if macOS asks whether \"$LABEL\" may send notifications, say Allow"
  echo "    (pomodoro boundaries; nothing else on the board notifies)"
  "$APP_EXEC" --notify-authorize >/dev/null 2>&1 || true
fi

if [ "$USE_LAUNCHER" -eq 1 ]; then
  echo "launcher: $APP_PATH ($BUNDLE_ID)"
  # Named on every successful run, not just the run that built it: this is the answer to
  # "why can't the board read that file", and the person hitting that is rarely the
  # person who watched the install scroll past.
  echo "          macOS attributes the daemon's file reads to this bundle. A reference into"
  echo "          ~/Documents, ~/Desktop or ~/Downloads needs it ticked in System Settings ->"
  echo "          Privacy & Security -> Files and Folders."
  # The one thing about the pomodoro notification this script cannot do for the reader.
  # Banner (auto-dismissing after a few seconds) versus Alert (stays until dismissed) is a
  # per-app setting macOS exposes only in System Settings — there is no API for it, which
  # is why this is a printed instruction rather than a line of code. It is worth printing
  # at all because the setting is the whole reason the notification comes from this bundle
  # rather than from osascript: before, the row to change said "Script Editor".
  echo "          Pomodoro notifications come from it too. To make them stay on screen until"
  echo "          dismissed: System Settings -> Notifications -> $LABEL -> Alerts."
fi
