# claude-board

A local review surface for Claude Code. Instead of answering questions one at a time
in a terminal, the agent hands you a **board** — a browser page carrying every question
at once with its real context beside it: rendered markdown, a diagram, a code
reference, a side-by-side comparison. You answer in any order, comment on any element
of a rendered stage or diagram by clicking it, and submit once. The agent's tool call
returns the whole packet as structured data.

**macOS only, by construction**: launchd supervision, `plutil` linting, `open` for the
tab. There is no Linux or Windows path and none is planned.

> **Pre-release.** A personal tool being prepared for release, not a finished product.
> Boards carry excerpts of whatever source files you asked the agent to render, so read
> [SECURITY.md](SECURITY.md) before installing.

## What it looks like

[`examples/sample-board.json`](examples/sample-board.json) is a fictional, finished
review — every block kind and answer widget, comments pinned to a diagram node, to an
element inside a rendered mock, and to a whole block — rendered to
[`examples/sample-board.html`](examples/sample-board.html), the same format a real
review is archived in. GitHub serves that file as plain text rather than a page, so it is
something to open locally: clone the repo and run `open examples/sample-board.html` — it
renders read-only, no daemon required. Clone rather than download the one file, because a
board names its script and stylesheet as siblings instead of carrying its own copy of
each (ADR 70), so an archive travels as a page plus the folder around it.

The board has two rounds, one pager flip apart, and opens on the newer one: the block
gallery below. The other round is a different shape entirely — a full-viewport artifact
with no card around it — reachable from the page by the pill at the bottom (or the edge
chevrons); its own screenshot is the second image below.

![Round 2 of the sample board, the block gallery it opens on: a markdown block with a comparison table, a mermaid flowchart carrying two comments, one on the whole block and one pinned to a node, a code block, a before/after compare of two rendered mocks, and an answered single-choice question with its own context panel.](examples/sample-board.png)

![Round 1 of the same board, one pager flip back: a full-viewport kitchen-display mock with no card or column around it, a numbered pin on its "Confirm" button, the comment it anchors floating over the artifact, and the round pager at the bottom naming both rounds.](examples/sample-board-comments.png)

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
- Node 22 or newer, at a stable path (`/opt/homebrew/bin/node`); the installer warns if
  the only node it finds is version-managed, because launchd keeps pointing at a path
  the next upgrade moves. Nothing checks the version for you — `npm` never runs, so
  `package.json`'s `engines` is never consulted, and an older node fails later as a
  health-check timeout that names the wrong cause
- Claude Code, with the `claude` CLI on your `PATH`
- The Xcode Command Line Tools (`xcode-select --install`), for `cc` — used once to build
  the launcher. Optional: without them the installer says so and still gives you a
  working install, one that cannot read board references out of `~/Documents`,
  `~/Desktop` or `~/Downloads`

Nothing is installed: no `npm install`, no `node_modules`, no bundler. Beyond node's own
built-ins, two rendering engines are vendored as readable source under `src/vendor/` and
pinned by sha256 (`marked` and `prismjs`, `ADR.md` entry 62); both run server-side when a board is
posted, so the page carries their output and never them. Mermaid is the one thing loaded
at view time, from jsdelivr when a diagram renders.

## Install

```sh
git clone https://github.com/JerryLui/claude-board.git ~/Documents/claude-board
cd ~/Documents/claude-board
bash install.sh
```

One idempotent command, and one click. Nothing that already matches is rebuilt on a
second run, which is what keeps the grant below from being asked for again.

**The clone is a build input, not what the daemon runs.** A `git pull` alone changes
nothing about what is running; re-run `bash install.sh` to take it.

`install.sh` never touches `~/.claude/settings.json`, so the optional `SessionStart` hook
that starts a pomodoro work interval with your session is applied by hand:
[INSTALL.md](INSTALL.md) carries the snippet, and tells an agent to ask you first. The
snippet stands down for any session that sets `CLAUDE_BOARD_NO_POMODORO`, which is how a
cron keepalive avoids starting an interval nobody is there for.

### The one click: allowing folder access

macOS gates `~/Documents`, `~/Desktop` and `~/Downloads` per application, and the
daemon is an application it has never heard of. So the installer builds
`~/Applications/claude-board.app`, a small signed launcher that runs the daemon, and
macOS asks whether *that* may read the folder — once, the first time it tries.

Refusing is a real option: everything works except rendering file references out of
those three folders, which show up on the board as `cannot read <path>: EPERM`.
Reversible either way later, under `claude-board` in **System Settings → Privacy &
Security → Files and Folders**.

The grant belongs to that launcher alone — which is why the installer builds a bundle
rather than handing `node` itself the keys to your Documents folder, the same permission
with a vastly wider blast radius ([SECURITY.md](SECURITY.md#defended)).

### The second click: allowing notifications

The bundle posts every notification claude-board raises, which is what puts its own name,
mark and cue on them instead of Script Editor's. There are two: a pomodoro boundary from
the clock on the index page, and a round left waiting on a board nobody is looking at.
macOS asks about them together and once, and the installer triggers the prompt at the end
of an install rather than letting it turn up hours later at the end of a work interval.
Saying no costs the notifications and nothing else.

Each has its own switch beside the clock, so silencing one leaves the other alone. Both
are a **banner** by default, gone in seconds whether or not you were looking. Set
claude-board to **Alerts** under **System Settings → Notifications** to make them wait for
you — a per-app setting with no API, and the reason a bundle of ours has to be the thing
posting.

`install.sh` prints these three when it finishes:

```sh
curl -s http://127.0.0.1:7391/api/health          # verify:   {"ok":true,...}
launchctl kickstart -k gui/$(id -u)/claude-board  # revive:   the daemon stopped answering
node ~/Documents/claude-board/bin/authorize.mjs   # authorize: another browser
```

A Claude Code session that was already running when you installed does not have the
`ask` tool; start a new session.

## Use

`install.sh` copies [`skills/claude-board/SKILL.md`](skills/claude-board/SKILL.md) into
`~/.claude/skills/claude-board/`, where Claude Code picks it up on its own — so asking
the agent to put its questions on the board is enough. Any command, skill or session can
also call the tool directly:

```
claude-board:ask(title, blocks[], wait?)
```

A tab opens on the first call. Answer what you want, leave the rest unanswered —
unanswered comes back explicitly marked, never defaulted — add a note beside any answer,
click **comment mode** and click any element of an HTML stage or a diagram to attach a
comment to it, then **Send**. Follow-up rounds push into the same tab as new pages: the
chevrons at the edges flip between rounds (so do the left and right arrow keys) and the
pill at the bottom names them and jumps to one, with every earlier round still readable
and no longer editable.

Two other ways out, beside Send: **Discuss in chat** returns immediately with whatever
is filled in and tells the agent to stop posting boards, and a wall-clock cap (default
40 minutes) returns an explicit no-response. Closing the tab is deliberately *not* a
cancel — the board stays live and its URL reopens it.

A rendered artifact posted on its own is a page nobody is asked to answer, so the call
returns the moment it lands. Pass `wait: true` to hold the call open instead: the page
gains a send control, and the comments left on it come back in that same call. If the cap
runs out first, the page says so and freezes — anything typed and not yet sent is filed to
the board on the way, and reaches whichever agent asks next rather than being lost with the
round.

`http://127.0.0.1:7391/` lists every thread with its rounds-left count, and filters that
list by title, project folder or thread id. Searching *inside* archived boards (what was
asked, what was answered, when) is `GET /api/search?q=`.

Content blocks reference a file rather than quoting it, and the daemon snapshots it at
post time. `SKILL.md` is the manual an agent reads, and the one thing this repo installs
beyond the daemon and its registration; [PROTOCOL.md](PROTOCOL.md) is the wire format
underneath.

### If a page says "this browser is not authorized"

Boards are served only to a browser claude-board has handed a credential to. The tab a
session opens is authorized automatically, and the URL it lands on carries no credential,
so you can reload and bookmark it freely. A browser that holds nothing — cleared cookies,
a different profile, a different browser — gets a page saying so, printing the
`authorize.mjs` command above with the right absolute path for your machine. It opens an
authorized tab and touches nothing else. Add `--print` for a link to paste into some
other browser, or a board id to land on that board rather than the index.

## How it works

- **A daemon** on `127.0.0.1:7391`, always on under launchd, owns the browser surface
  for every session on the machine.
- **A stdio MCP server** per Claude Code session hands boards to it and blocks on the
  answer, emitting progress notifications so the call is never idle-aborted. Claude Code
  backgrounds it after roughly two minutes, so your session stays interactive while the
  page is open.
- **JSON is truth.** A board is a JSON document and the page is a pure function of it, so
  an archived board double-clicked from Finder renders read-only with no daemon running —
  as long as its folder comes too, since the page names the shared script and stylesheet
  sitting beside it rather than carrying its own copy of each. (A mermaid diagram in it
  still fetches its renderer from jsdelivr.) Re-rendering old boards after a design change
  is a loop over the store, not a migration.

Boards live outside this repository, under
`~/Library/Application Support/claude-board/` (override with `CLAUDE_BOARD_HOME`), so
review content is never committed.

## Uninstall

```sh
bash uninstall.sh
```

Removes the launchd job, its plist, the MCP registration, the launcher bundle in
`~/Applications` along with its LaunchServices record, and the manual it copied into
`~/.claude/skills/`. It names what it
deliberately leaves: the store (your review history), the local secret, the logs. Safe
to run twice, and on a machine that never had the service installed.

One leftover no script can remove: `claude-board` may still be listed under System
Settings → Privacy & Security → Files and Folders. The bundle it refers to is gone, so
the entry grants nothing, but macOS offers no way to delete it programmatically.

## Development

```sh
npm run check      # the full suite, node only, no browser and no network
```

**Take a code change with `./install.sh`, never `launchctl kickstart`.** The daemon runs
a copy of `bin/daemon.mjs` and `src/` staged inside the launcher bundle, so a kickstart
bounces it visibly while it goes on running your old code. Reserve kickstart for reviving
an unresponsive daemon on the code it already has. [QUIRKS.md](QUIRKS.md) has that trap
and the rest of them.

The interactive layer — drag-to-rank, click-to-comment, notifications, live hydration —
is verified by hand, not by the suite. QUIRKS.md records every green check this project
has caught sitting on top of a dead feature, and why the suite missed it.

## License

MIT — see [LICENSE](LICENSE).
