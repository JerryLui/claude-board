# Installing by hand

Three pieces `install.sh` cannot do on its own: the board manual it writes only when it
runs, the skills already on this machine that could route their questions to the board, and
the optional session-start hook it never writes.

## Refreshing the board manual

`skills/claude-board/SKILL.md`, the manual for the `ask` tool, is copied to
`~/.claude/skills/claude-board/SKILL.md` by step 6 of `install.sh`. The copy in `~/.claude`
is what the agent reads, so editing the clone changes nothing on a machine that already
installed. Re-run `install.sh`, or copy the one file:

```sh
cp skills/claude-board/SKILL.md ~/.claude/skills/claude-board/SKILL.md
```

Make the edit in the clone: a reinstall overwrites the installed copy rather than
preserving it, and `test/check-install.mjs` asserts the two are byte-identical.

## Routing existing skills to the board — optional, ask first

The manual's description fires on the situation now — more than one question to put, a mock
to hand over for a reaction — so a skill that says nothing about the board still reaches it.
This section is for the stronger claim: a skill that should *always* ask on the board, and
whose own prose still routes it to the terminal.

**Everything below is read by an agent, and the first write happens after step 2's answers
come back.**

### Step 1 — inventory, read only

Find the callers under `~/.claude` that put more than one question to the user in a run:
`skills/*/SKILL.md`, `commands/*.md`, `agents/*.md`, matching on `AskUserQuestion` or on
prose describing an interview, a review round, or a set of options.

Four exclusions, each of which makes an edit worse than no edit:

- `~/.claude/skills/claude-board/` — `install.sh` overwrites it on every run. Edits there
  are lost without a word. The clone is where that file changes.
- Anything under `~/.claude/plugins/` — a plugin update overwrites the edit the same way,
  and the reader did not author the file.
- A caller that runs unattended (a cron line, `claude -p`, CI). The board refuses a headless
  session by design, so routing one there converts a working run into a fallback path.
- A caller whose whole interview is a lone follow-up or a yes/no. The manual's "When not to
  use the board" section keeps those in the terminal; opening a tab for one question is
  worse than answering it inline.

Report the survivors as a list — path, what each asks, how many questions in a run — and
stop.

### Step 2 — the round

Put the decision on a board, the same shape the callers are being migrated to. Four
questions, each carrying a recommended answer and the reason for it, with the candidate
files themselves as the context beside them:

1. **Which callers route to the board?** Multi-select, one option per survivor. Recommend
   the ones that fan out three or more questions in a single interview; a two-question
   caller is a judgement call, not a default.
2. **How deep does the edit go?** Single choice. Recommended: a pointer line and nothing
   else — the caller names the board, the manual keeps the mechanism. The alternatives are
   rewriting the interview into rounds (more work, more drift surface) and adding an
   explicit off-board sentence per caller (the manual already covers the fallback).
3. **Which of these ever run with nobody watching?** Multi-select over the same list, so a
   caller the inventory could not classify is confirmed by the person who wrote it rather
   than guessed at. Anything selected here drops out.
4. **What is the undo?** Single choice. Recommended: `git init` in `~/.claude` and one
   commit before the first edit. Alternatives: a timestamped copy of the directory, or
   already version-controlled. There is no answer that means "no undo" — the edits change
   the reader's own files, outside any repo this project owns.

### Step 3 — the edit

**The edit is a pointer, never a copy.** Name the board, hand the mechanism to the manual:

> Questions go on the board. **Read the `claude-board` skill for the call, the block kinds,
> the widgets, the packet and the fallback** — that skill is the protocol.

A widget list, an argument name, a block kind or a packet field written into a caller is a
second copy of the manual, and it drifts the first time the protocol moves.
`skills/grill-example/SKILL.md` in the clone is a caller written to this rule; copy its
shape rather than inventing one.

Three files, then show the diffs and wait for a yes before the next three. A caller that
turns out mid-edit to be a yes/no in disguise goes back on the excluded list instead of
through.

### Verifying

Skill descriptions load when a session starts, so an edited caller is not live in the
session that edited it. Start a fresh one, run one edited caller, and confirm the round
lands on the board and the packet comes back. Then revisit the excluded list once: an
exclusion that was wrong is cheaper to fix now than after the reader has forgotten the
inventory.

### Undoing

Whatever step 2's question 4 answered — `git checkout` in `~/.claude`, or restoring the
copy. `uninstall.sh` leaves these callers alone; it did not write them.

## The session-start hook — optional, ask first

A `SessionStart` hook that starts a pomodoro work interval when a Claude Code session
starts. The board works without it; it only decides whether the timer starts itself or
waits for the index page's switch. Both defer to the board's own **Pomodoro timer**
switch in its settings panel: with that off, `ensure` is refused by the daemon and this
hook starts nothing, hook installed or not.

**Ask before applying it.** Put a yes/no question to the reader with `AskUserQuestion` —
"Install the SessionStart hook that starts a pomodoro when a Claude Code session starts?"
— and edit `~/.claude/settings.json` only on a yes. On a no, stop here: the rest of this
section is the yes branch, and nothing else in the install depends on it.

Hand-applied because `install.sh` never reads or writes `~/.claude/settings.json`, which
is not this repo's file, and there is no `claude hooks` CLI to shell out to — so the
reader's own settings are the one file an agent touches here.

Safe to run on every session: `POST /api/pomodoro/ensure` starts a work interval only
when no timer exists at all. A running, paused, or mid-break timer is left exactly as
it was, so a second session, a `/clear`, or a resume is a no-op (proved in
`test/check-http.mjs` and `test/check-install-doc.mjs`) — and so is every call while
the board's Pomodoro timer switch is off.

## The entry

```json
{
  "type": "command",
  "command": "[ -n \"$CLAUDE_BOARD_NO_POMODORO\" ] && exit 0 ; (curl -s -m 2 -X POST -H \"x-claude-board-secret: $(cat \"$HOME/.config/claude-board/secret\" 2>/dev/null)\" \"http://127.0.0.1:${CLAUDE_BOARD_PORT:-7391}/api/pomodoro/ensure\" >/dev/null 2>&1 &) ; exit 0"
}
```

Keep the shape exactly, every part of it load-bearing:

- `[ -n "$CLAUDE_BOARD_NO_POMODORO" ] && exit 0` first, ahead of the `curl` and ahead of
  reading the secret, so an unattended session never reaches the daemon at all. Nothing in
  a `SessionStart` payload gives that session away — `source` is `startup` for a
  `claude -p` one-liner exactly as for a real one, and TTY detection is no help either
  since the payload arrives on stdin and stdout is captured, so both are pipes when a
  person *is* sitting there. So the caller declares itself instead (ADR.md entry 68). An
  empty value counts as unset, which is how a shell that already exports it opts a single
  command back in.
- Secret header from `~/.config/claude-board/secret`. A browser reaches `ensure` on the
  session cookie alone, but this is a shell `curl`, which holds no cookie: the secret is
  the only credential it can present.
- `${CLAUDE_BOARD_PORT:-7391}` matches `src/handoff.mjs` `DEFAULT_PORT`.
- `-m 2`, backgrounded `(… &)`, and `; exit 0` so no daemon state — down, wedged, no
  secret file, connection refused — can delay or fail a session start.
- `>/dev/null 2>&1` because `SessionStart` stdout becomes `additionalContext`.

## Marking a session unattended

The guard does nothing until something sets the variable, and the hook has no way to work
out for itself which sessions those are. So whatever starts a session with nobody in front
of it sets the variable in that session's own environment: a cron keepalive, a scheduled
agent, a script warming a session up. A crontab line takes it as an ordinary command
prefix:

```sh
0 5 * * * CLAUDE_BOARD_NO_POMODORO=1 claude -p "Respond with hello"
```

Left unset, those sessions start a work interval each time they fire. The cost is not the
stray interval itself but what it does to the real day: `ensure` leaves an existing timer
alone, so the reader's first actual session finds the 05:00 cron's interval already
running, most of it spent while they were asleep.

## Applying it: append, don't replace

`hooks.SessionStart` is an **array of matcher groups**, each with its own `hooks`
array, and a real `settings.json` already carries hooks from elsewhere. A top-level
`"SessionStart": [ … ]` key pasted over it clobbers every hook already there.

Append the entry to the `hooks` array of a group that applies to every session
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
          { "type": "command", "command": "…the entry above, verbatim…" }
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
than `ensure`. With the board's Pomodoro timer switch off, expect `timer: null`
instead — `ensure` refuses while it is off.

For the guard, run the command itself rather than starting a session:
`CLAUDE_BOARD_NO_POMODORO=1 bash -c '<the command above>'` must leave `timer` exactly as
it found it — `null` if there was none.

## Removing

`uninstall.sh` doesn't touch this hook — it didn't install it. Delete the entry from
`~/.claude/settings.json` yourself.
