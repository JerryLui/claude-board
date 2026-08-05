# Installing by hand

Two pieces `install.sh` cannot keep current on its own: the session-start hook it never
writes, and the board manual it writes only when it runs.

## Refreshing the board manual

`skills/claude-board/SKILL.md`, the manual for the `ask` tool, is copied to
`~/.claude/skills/claude-board/SKILL.md` by step 6 of `install.sh`. Editing the clone
therefore changes nothing on a machine that already installed: the copy in `~/.claude` is
what the agent reads. Re-run `install.sh`, or copy the one file:

```sh
cp skills/claude-board/SKILL.md ~/.claude/skills/claude-board/SKILL.md
```

Either way the installed copy must end up byte-identical to the clone's, which is what
`test/check-install.mjs` asserts. A reinstall overwrites an edited copy rather than
preserving it, so `~/.claude` is never the place to make the edit.

## The session-start hook

A `SessionStart` hook that starts a pomodoro work interval when a Claude Code session
starts. Hand-applied: `install.sh` never reads or writes `~/.claude/settings.json`,
which is not this repo's file (ADR.md entry 5), and there is no `claude hooks` CLI to
shell out to.

Safe to run on every session: `POST /api/pomodoro/ensure` starts a work interval only
when no timer exists at all. A running, paused, or mid-break timer is left exactly as
it was, so a second session, a `/clear`, or a resume is a no-op (PROTOCOL.md "The
pomodoro clock"; proved in `test/check-http.mjs` and `test/check-install-doc.mjs`).

## The entry

```json
{
  "type": "command",
  "command": "(curl -s -m 2 -X POST -H \"x-claude-board-secret: $(cat \"$HOME/.config/claude-board/secret\" 2>/dev/null)\" \"http://127.0.0.1:${CLAUDE_BOARD_PORT:-7391}/api/pomodoro/ensure\" >/dev/null 2>&1 &) ; exit 0"
}
```

The shape matters, don't simplify it:

- Secret header from `~/.config/claude-board/secret`; `ensure` is secret-only, the
  browser cookie is deliberately not accepted (`src/server.mjs`
  `POMODORO_COOKIE_ACTIONS`).
- `${CLAUDE_BOARD_PORT:-7391}` matches `src/handoff.mjs` `DEFAULT_PORT`.
- `-m 2`, backgrounded `(… &)`, and `; exit 0` so no daemon state — down, wedged, no
  secret file, connection refused — can delay or fail a session start.
- `>/dev/null 2>&1` because `SessionStart` stdout becomes `additionalContext`.

## Applying it: append, don't replace

`hooks.SessionStart` is an **array of matcher groups**, each with its own `hooks`
array, and a real `settings.json` already carries hooks from elsewhere.

**Pasting a top-level `"SessionStart": [ … ]` key clobbers every hook already there.**
Instead, append the entry to the `hooks` array of a group that applies to every session
(`"matcher": "*"`, or empty/absent). If no such group exists, append a new matcher
group without touching the existing ones. If there's no `SessionStart` key at all, add
the whole block:

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "…existing, untouched…" },
          { "type": "command", "command": "(curl -s -m 2 -X POST -H \"x-claude-board-secret: $(cat \"$HOME/.config/claude-board/secret\" 2>/dev/null)\" \"http://127.0.0.1:${CLAUDE_BOARD_PORT:-7391}/api/pomodoro/ensure\" >/dev/null 2>&1 &) ; exit 0" }
        ]
      }
    ],
    "PreToolUse": [ /* … untouched … */ ]
  }
}
```

## Verifying

Start a new session, then:

```sh
curl -s http://127.0.0.1:7391/api/pomodoro | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).timer))'
```

(add the secret header when calling from outside a session — PROTOCOL.md "The local
secret"). Expect a `work` phase timer with a future `deadline`. A second session or a
`/clear` must not move that deadline; if it does, something is calling a route other
than `ensure`.

## Removing

`uninstall.sh` doesn't touch this hook — it didn't install it. Delete the entry from
`~/.claude/settings.json` yourself.
