# Installing the session-start hook

`install.sh` installs the daemon, the local secret and the launcher bundle. It does
**not** install what follows here: a `SessionStart` hook that starts a pomodoro work
interval when your Claude Code session starts, so the timer begins with your work
rather than waiting for you to remember it exists.

## Why this isn't in `install.sh`

Because `~/.claude/settings.json` is not this repo's file, and `install.sh` never reads
or writes it (ADR.md entry 5 — the same rule that already kept `/grill` out of this
repo). That file is git-versioned, synced by your own tooling, and — on any machine
that has run more than one thing through Claude Code — already carries a dozen-plus
hook entries you did not get from here, very possibly including a `SessionStart` entry
of its own. A script that merges JSON into a file like that gets it wrong exactly once
and silently deletes someone's hooks; there is also no `claude hooks` CLI the way there
is `claude mcp add` for install.sh to shell out to. So this is a hand-applied step, not
a missing one. Apply it yourself, or ask the agent running this install to apply it —
either way, read the warning below first.

## What the hook proves, and what it doesn't

The daemon already guarantees the property this hook depends on:
`POST /api/pomodoro/ensure` starts a work interval **only** when no timer exists at
all. A running timer, a paused timer, and a timer mid-break are all left exactly as
they were — so a second session, a `/clear`, a resume, or a session in some other
project while a timer is already running is a no-op, and a session that starts mid-break
does not cut the break short. See `PROTOCOL.md` "The pomodoro clock" and
`test/check-http.mjs`'s pomodoro section, which proves it over HTTP. This hook is not
reimplementing that guarantee — it is one `curl` away from it, on every session start.

## The command

```sh
curl -s -m 2 -X POST \
  -H "x-claude-board-secret: $(cat "$HOME/.config/claude-board/secret" 2>/dev/null)" \
  "http://127.0.0.1:${CLAUDE_BOARD_PORT:-7391}/api/pomodoro/ensure" \
  >/dev/null 2>&1
```

Shown unescaped, for reading. What's actually pasted into `settings.json` is below,
backgrounded and forced to exit 0 — the shape that matters:

- **`x-claude-board-secret`** comes from `~/.config/claude-board/secret`
  (`src/secret.mjs` `secretPath()`, overridable by `CLAUDE_BOARD_SECRET_FILE`, which a
  session-start hook has no reason to set). `POST /api/pomodoro/ensure` is
  secret-header-only — the browser session cookie is deliberately not accepted here
  (`src/server.mjs` `POMODORO_COOKIE_ACTIONS`), because this hook's one caller is a
  shell script holding the secret, never a browser.
- **`${CLAUDE_BOARD_PORT:-7391}`** matches the daemon's own default
  (`src/handoff.mjs` `DEFAULT_PORT`) without hardcoding it where you've overridden it.
- **`-m 2`** bounds the request to two seconds so a wedged daemon can't add latency to
  every session start.
- **Backgrounded and detached**, `(… &)`, so Claude Code never waits on it — the
  subshell forks the request and returns immediately, whatever the request ends up
  doing.
- **`; exit 0`** unconditionally, whatever curl's own exit status is — a daemon that
  isn't running, a secret file that doesn't exist, a connection actively refused, all
  land here, and none of them may fail a session start. A hook that can fail a
  session start over a break reminder is a worse bug than the one this ticket fixes.
- **`>/dev/null 2>&1`**, because a `SessionStart` hook's stdout can become
  `additionalContext` fed back into the session, and nothing this command could print —
  a curl error, a JSON body — is context Claude Code should ever see.

The exact snippet to paste, JSON-escaped as it needs to appear inside
`settings.json`'s `command` string:

```json
{
  "type": "command",
  "command": "(curl -s -m 2 -X POST -H \"x-claude-board-secret: $(cat \"$HOME/.config/claude-board/secret\" 2>/dev/null)\" \"http://127.0.0.1:${CLAUDE_BOARD_PORT:-7391}/api/pomodoro/ensure\" >/dev/null 2>&1 &) ; exit 0"
}
```

## Applying it: append, don't replace — read this before you paste anything

`SessionStart` in `settings.json` is an **array of matcher groups**, and each group has
its own `hooks` **array**. A real `settings.json` looks like this, typically with a
dozen-plus other event keys beside `SessionStart` — the rtk Bash rewriter or whatever
else you've wired up:

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "…some existing command…" }
        ]
      }
    ],
    "PreToolUse": [ /* … your other hooks, untouched … */ ]
  }
}
```

**Pasting a top-level `"SessionStart": [ … ]` key over that clobbers every hook
already in the array.** That is the single most important sentence in this file: it
silently destroys hooks you did not put here and were not asked about. What you want
instead is to add the entry above to the `hooks` array of an existing matcher group
that already applies to every session (`"matcher": "*"`, or an empty/absent matcher,
both of which mean "always"), or — if no such group exists — append a whole new
matcher-group object to the `SessionStart` array without touching the ones already
there:

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "…some existing command…" },
          { "type": "command", "command": "(curl -s -m 2 -X POST -H \"x-claude-board-secret: $(cat \"$HOME/.config/claude-board/secret\" 2>/dev/null)\" \"http://127.0.0.1:${CLAUDE_BOARD_PORT:-7391}/api/pomodoro/ensure\" >/dev/null 2>&1 &) ; exit 0" }
        ]
      }
    ],
    "PreToolUse": [ /* … untouched … */ ]
  }
}
```

If your `settings.json` has no `hooks.SessionStart` key at all, the whole block above
(minus the pre-existing command) is what to add.

### Doing it

By hand: open `~/.claude/settings.json` in an editor and make the edit above. It's one
array insertion.

By agent: point it at this file and `~/.claude/settings.json` and ask it to add the
entry from "The command" above to the existing `SessionStart` matcher group that
applies to every session — not to overwrite the `SessionStart` key. Show it the
before/after in this file; an agent that hasn't seen the warning above will reach for
the obvious-looking (and wrong) top-level replacement.

## Verifying it worked

Start a new Claude Code session, then check the daemon picked it up:

```sh
curl -s http://127.0.0.1:7391/api/pomodoro | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).timer))'
```

(add the secret header if your daemon has one and you're testing from outside a
session — see `PROTOCOL.md` "The local secret"). You should see a `work` phase timer
with a `deadline` a work-interval's length in the future. Opening a second session, or
`/clear`-ing this one, must **not** move that deadline — if it does, something is
calling a route other than `ensure`.

## Removing it

`uninstall.sh` does not touch this hook — it didn't install it, so it isn't its
place to remove it (same reasoning as `/grill`, ADR.md entry 5). Delete the entry
from `~/.claude/settings.json` yourself.
