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
> product. Boards contain excerpts of whatever source files you asked the agent to
> render, so read [SECURITY.md](SECURITY.md) before installing — in short: every route
> needs a credential, and any process running as *you* holds it by definition.

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
- The Xcode Command Line Tools (`xcode-select --install`), for `cc` — used once at
  install time to build the launcher described below. Optional: without them you get a
  working install that cannot read board references out of `~/Documents`, `~/Desktop` or
  `~/Downloads`, and the installer says so rather than failing

No runtime dependencies. Node built-ins only.

## Install

```sh
git clone https://github.com/JerryLui/claude-board.git ~/Documents/claude-board
cd ~/Documents/claude-board
bash install.sh
```

One idempotent command, and one click. It generates a local secret, builds the launcher
bundle, installs a launchd job running the daemon from this clone, waits for the daemon
to actually answer before claiming success, and registers the MCP server with Claude Code
at user scope. Running it again changes nothing that already matches: the secret is never
rotated and the launcher is not rebuilt unless something it is built from changed.

This installs the service and its credential — nothing that calls them. `claude-board`
ships the daemon, the shim and the protocol; it ships no commands or skills (see
[ADR.md](ADR.md) entry 5). `/grill`, the board's original caller, now lives at
`~/.claude/commands/grill.md`, versioned in your own `~/.claude` alongside whatever else
you point at the board — install that separately, on its own schedule.

### The one click: allowing folder access

macOS gates `~/Documents`, `~/Desktop` and `~/Downloads` per application, and the
daemon is an application it has never heard of. So the installer builds
`~/Applications/claude-board.app`, a small signed launcher that runs the daemon, and
macOS asks whether *that* may read the folder — once, the first time it tries.

**Click Allow.** If you clone into one of those three folders (the command above clones
into `~/Documents`), the daemon cannot read its own code until you do, and the install
will sit waiting for you. You can change your mind later in **System Settings → Privacy
& Security → Files and Folders**, under `claude-board`.

Two consequences worth knowing. Refusing is a real option: everything works except
rendering file references out of those three folders, which show up on the board as
`cannot read <path>: EPERM`. And the grant belongs to the launcher alone — this is why
the installer builds a bundle instead of asking you to hand `node` itself the keys to
your Documents folder, which is the same permission with a vastly wider blast radius.
See [SECURITY.md](SECURITY.md#defended).

Verify:

```sh
curl -s http://127.0.0.1:7391/api/health     # {"ok":true,...}
```

If the daemon ever stops answering:

```sh
launchctl kickstart -k gui/$(id -u)/claude-board
```

## Use

Any command or skill that calls the `ask` tool can post a board — this repo does not ship
one. `/grill`, the original caller, lives at `~/.claude/commands/grill.md`; see its own
file for the source of truth on what it does. As an example: run it on a decision, a
design, or a spec. When it has more than a couple of
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

### If a page says "this browser is not authorized"

Boards are served only to a browser claude-board has handed a credential to. The tab a
session opens is authorized automatically, and the URL it lands on carries no credential,
so you can reload and bookmark it freely. A browser that holds nothing — you cleared
cookies, switched profiles, or opened the link in a different browser — gets a page
saying so. One command fixes it:

```sh
node ~/Documents/claude-board/bin/authorize.mjs      # adjust to wherever you cloned it
```

It opens an authorized tab. Nothing is reinstalled, nothing restarts, your boards are
untouched. Add `--print` to get a link to paste into some other browser instead, or a
board id to land on that board rather than the index. The refusal page prints this
command with the right absolute path for your machine, so you can copy it from there.

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

```sh
bash uninstall.sh
```

Removes the launchd job, its plist, the MCP registration, and the launcher bundle in
`~/Applications`. It does not touch `~/.claude/commands/grill.md` or any other command
file — this repo does not install one, so it has nothing of its own to take back there.
It reports what it deliberately did not touch: the store (your review history), the local
secret at `~/.config/claude-board/secret`, and the logs in `~/Library/Logs/claude-board/`.
Remove those yourself if you want them gone. Safe to run on a machine that never had the
service installed, and safe to run twice.

One leftover no script can remove: `claude-board` may still be listed under System
Settings → Privacy & Security → Files and Folders. The bundle it refers to is gone, so
the entry grants nothing, but macOS offers no way to delete it programmatically.

## Development

```sh
npm run check      # 21 checks, node only, no browser and no network
```

Every check is also runnable alone, and each runs under a deadline in its own process
group, so a check that hangs fails by name instead of stalling the run.

One gotcha worth knowing before you debug anything: the installed daemon reloads
itself on a code change, but not through the plist. `install.sh` sets
`CLAUDE_BOARD_RELOAD_ON_CHANGE=1` in the plist's environment, which tells
`bin/daemon.mjs` to watch its own `src/` and `bin/` and exit the moment either
changes; `KeepAlive` is what actually brings it back up. A plist-level `WatchPaths`
can't do this — it only ever *starts* a job that isn't running, and `KeepAlive`
guarantees this one always already is, so the two fight instead of composing (see
[QUIRKS.md](QUIRKS.md)). launchd also will not restart a job more than once per
10 seconds, so two edits inside one 10s window collapse into a single restart — if
you save twice in a row, the second edit's reload waits out the rest of that window.
A reload drops every open event stream and every held-open wait, so saving a file
mid-review costs the tab a reconnect: the page's `EventSource` reattaches on its own
and a waiting shim reattaches by board id, but a board mid-answer is a board whose
live updates paused for a moment.
If the daemon is ever unresponsive and you want it back immediately rather than
waiting on a save to land, kick it yourself:

```sh
launchctl kickstart -k gui/$(id -u)/claude-board
```

More traps in [QUIRKS.md](QUIRKS.md).

The interactive layer — drag-to-rank, click-to-comment, notifications, live hydration
— is verified by hand, not by the suite. That is a deliberate limit, not an oversight:
this project has a running record of green checks accompanying a completely dead
feature, most from asserting structure instead of behaviour, one from mocking someone
else's renderer wrongly, and more from browser mechanisms (pointer capture, layout
measurement) the suite's DOM stand-in has no model of at all. See [QUIRKS.md](QUIRKS.md)
for each recorded instance and why the suite missed it.

## Portability

macOS only, by construction: launchd supervision, `plutil` linting, `open` for the
tab. A systemd path would be a second platform to test on machines the author does not
have, and every guard would be written against a setup nobody has exercised. Named as a
limitation rather than half-shipped.

## License

MIT — see [LICENSE](LICENSE).
