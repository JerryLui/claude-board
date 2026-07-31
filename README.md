# claude-board

A local review surface for Claude Code. Instead of answering questions one at a time
in a terminal, the agent hands you a **board** — a browser page carrying every question
at once with its real context beside it: rendered markdown, a diagram, a code
reference, a side-by-side comparison. You answer in any order, comment on any element
by clicking it, and submit once. The agent's tool call returns the whole packet as
structured data.

**macOS only.** The daemon is supervised by launchd and the tab is opened with `open`.
There is no Linux or Windows path and none is planned; see [Portability](#portability).

> **Pre-release.** This is a personal tool being prepared for release, not a finished
> product. Read [SECURITY.md](SECURITY.md) before installing: any process running on
> your machine can currently read every board and forge an answer on one, and boards
> contain excerpts of whatever source files you asked the agent to render. Closing
> that is the current work.

## Why

`AskUserQuestion` gives you at most four questions per call, in a terminal, with a
label and one sentence per option. A design review with a dozen open branches becomes a
serial interrogation: you answer question one while already knowing you want to react
to question four first, and each question arrives stripped of the context needed to
answer it well. Reviewing anything visual is the same problem from the other side —
describing a reaction to an architecture diagram in prose when pointing at the thing
would take two seconds.

## Requirements

- macOS
- Node 22 or newer, ideally installed somewhere stable (`/opt/homebrew/bin/node`); the
  installer warns if the only node it finds is version-managed, because launchd will
  keep pointing at a path that moves on the next upgrade
- Claude Code, with the `claude` CLI on your `PATH`

No dependencies, no build step. Node built-ins only.

## Install

```sh
git clone https://github.com/JerryLui/claude-board.git ~/Documents/claude-board
cd ~/Documents/claude-board
bash install.sh
```

One idempotent command. It generates a local secret, installs a launchd job running
the daemon from this clone, waits for the daemon to actually answer before claiming
success, and registers the MCP server with Claude Code at user scope. Running it again
changes nothing and never rotates the secret.

Then install the `/grill` command, which is the first caller of the board:

```sh
cp commands/grill.md ~/.claude/commands/grill.md
```

Verify:

```sh
curl -s http://127.0.0.1:7391/api/health     # {"ok":true,...}
```

If the daemon ever stops answering:

```sh
launchctl kickstart -k gui/$(id -u)/claude-board
```

## Use

Run `/grill` on a decision, a design, or a spec. When it has more than a couple of
questions it posts a board and a tab opens. Answer what you want, leave the rest
unanswered — unanswered comes back explicitly marked, never defaulted — add a note
beside any answer, click **comment mode** and click any element on the page to attach a
comment to it, then **Send**. Follow-up rounds push into the same tab, with the
previous round collapsed into a history rail and its answers still readable.

The page follows your OS's light/dark preference by default; a control in the header
cycles System → Light → Dark, and the choice is remembered per origin. A standalone
archive always follows the OS and remembers nothing.

Two other ways out, beside Send: **Discuss in chat** returns immediately with whatever
is filled in and tells the agent to stop posting boards, and a wall-clock cap (default
two hours) returns an explicit no-response rather than blocking the call forever.
Closing the tab is deliberately *not* a cancel — the board stays live and its URL
reopens it.

`http://127.0.0.1:7391/` lists every thread with its pending count, and searches
archived boards: what was asked, what was answered, when.

Any other command or session can post a board directly through the MCP tool:

```
claude-board:ask(title, blocks[])
```

Questions carry their prompt by value; content blocks carry a reference to a file plus
an optional section or line range, which the daemon resolves and snapshots at post
time. Block kinds are `markdown`, `mermaid`, `code`, `html`, `compare` and `question`;
answer widgets are single-choice cards, multi-select, free text and drag-to-rank. See
[PROTOCOL.md](PROTOCOL.md) for the full wire format.

## How it works

- **A daemon** on `127.0.0.1:7391`, always on under launchd, owns the browser surface
  for every session on the machine.
- **A stdio MCP server** per Claude Code session hands boards to it and blocks on the
  answer, emitting progress notifications so the call is never idle-aborted. Claude
  Code auto-backgrounds it after roughly two minutes, so your session stays
  interactive while the page is open.
- **JSON is truth.** A board is a JSON document; the page is a pure function of it,
  emitted with its own source inlined, so an archived board double-clicked from Finder
  renders read-only with no daemon running. Re-rendering old boards after a design
  change is a loop over the store, not a migration.

Boards live outside this repository, under
`~/Library/Application Support/claude-board/` (override with `CLAUDE_BOARD_HOME`), so
review content is never committed.

## Uninstall

There is no uninstall script yet. By hand:

```sh
launchctl bootout gui/$(id -u)/claude-board
rm ~/Library/LaunchAgents/claude-board.plist
claude mcp remove claude-board --scope user
rm ~/.claude/commands/grill.md
```

That leaves three things deliberately: the store, the local secret at
`~/.config/claude-board/secret`, and the logs in `~/Library/Logs/claude-board/`. Remove
them yourself if you want them gone — the store is your review history.

## Development

```sh
npm run check      # 21 checks, node only, no browser and no network
```

Every check is also runnable alone, and each runs under a deadline in its own process
group, so a check that hangs fails by name instead of stalling the run.

One gotcha worth knowing before you debug anything: editing `src/` or `bin/` does **not**
reload the service. The plist carries `WatchPaths` on both directories, but it also
carries `KeepAlive`, and `WatchPaths` only ever *starts* a job that is not running — so
the watch is inert and a stale daemon looks exactly like a working one. Restart it
yourself after a code change:

```sh
launchctl kickstart -k gui/$(id -u)/claude-board
```

More traps in [QUIRKS.md](QUIRKS.md).

The interactive layer — drag-to-rank, click-to-comment, notifications, live hydration
— is verified by hand, not by the suite. That is a deliberate limit, not an oversight:
this project has three recorded instances of green checks accompanying a completely
dead feature, twice from asserting structure instead of behaviour and once from mocking
someone else's renderer wrongly.

## Portability

macOS only, by construction: launchd supervision, `plutil` linting, `open` for the
tab. A systemd path would be a second platform to test on machines the author does not
have, and every guard would be written against a setup nobody has exercised. Named as a
limitation rather than half-shipped.

## License

MIT — see [LICENSE](LICENSE).
