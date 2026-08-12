# claude-board

[![check](https://github.com/JerryLui/claude-board/actions/workflows/check.yml/badge.svg)](https://github.com/JerryLui/claude-board/actions/workflows/check.yml)

A local review surface for Claude Code. Instead of answering questions one at a time
in a terminal, the agent hands you a **board**: a browser page carrying every question
at once, with its real context beside it. Rendered markdown, a diagram, a code
reference, a side-by-side comparison. You answer in any order, click any rendered
artifact to comment on it, and submit once. The tool call returns the whole packet as
structured data.

**macOS only, by construction**: launchd supervision, `plutil` linting, `open` for the
tab. No Linux or Windows path exists or is planned.

> **Pre-release.** A personal tool being prepared for release, not a finished product.
> Boards carry excerpts of the files you ask the agent to render, so read
> [SECURITY.md](SECURITY.md) before installing.

## What it looks like

![Round 2 of the sample board, the block gallery it opens on: a markdown block with a comparison table, a mermaid flowchart carrying two comments, one on the whole block and one pinned to a node, a highlighted javascript block and a diff block, a before/after compare of two rendered mocks, and an answered single-choice question with its own context panel.](examples/sample-board.png)

![Round 1 of the same board, one pager flip back: a full-viewport kitchen-display mock with no card or column around it, a numbered pin on its "Confirm" button, the comment it anchors floating over the artifact, and the round pager at the bottom naming both rounds.](examples/sample-board-comments.png)

Both screenshots show one fictional, finished review:
[`examples/sample-board.json`](examples/sample-board.json), every block kind and answer
widget, comments pinned to a diagram node, to an element inside a rendered mock, and to
a whole block. **See it rendered, no clone required:**
[jerrylui.github.io/claude-board/sample-board.html](https://jerrylui.github.io/claude-board/sample-board.html).

A board grows in **rounds**: each post lands as a new page in the same tab, and the
pager at the bottom flips between them. Earlier rounds stay readable and stop being
editable the moment the next one lands.

After installing, `npm run demo` posts that same sample board to your own daemon and
opens it. One command proves the daemon, the MCP registration and the browser hop all
work, without waiting for an agent to ask you something. It fails with a clear message
rather than hanging when the daemon is unreachable.

## Why

`AskUserQuestion` gives you at most four questions per call, in a terminal, with a
label and one sentence per option. A design review with a dozen open branches becomes
a serial interrogation, and each question arrives stripped of the context needed to
answer it. Reviewing anything visual is the same problem from the other side:
describing a reaction to a diagram in prose, when pointing at the thing would take two
seconds.

## Install

As a Claude Code plugin (the repo is its own marketplace):

```
/plugin marketplace add JerryLui/claude-board
/plugin install claude-board@claude-board
/claude-board:install
```

Or from a clone:

```sh
git clone https://github.com/JerryLui/claude-board.git ~/src/claude-board
cd ~/src/claude-board
bash install.sh
```

Both run the same `install.sh`: one idempotent command, and one click. Verify and
revive:

```sh
curl -s http://127.0.0.1:7391/api/health          # expect {"ok":true,...}
launchctl kickstart -k gui/$(id -u)/claude-board  # daemon stopped answering
```

Authorizing a second browser is below, under "this browser is not authorized."

A session that was already running when you installed does not have the `ask` tool;
start a new one.

### Requirements

- macOS. `install.sh` refuses anything else, before it writes a thing.
- Node 22 or newer, at a stable path (Homebrew's `/opt/homebrew/bin/node` or
  `/usr/local/bin/node`, or the system `/usr/bin/node`). Checked up front. A node
  managed by `mise`, `nodenv`, `fnm` or similar gets a warning: launchd would keep
  pointing at wherever that path was on install day.
- Claude Code, with `claude` on your `PATH`. Also checked up front.
- Xcode Command Line Tools (`xcode-select --install`), for the one `cc` call that
  builds the launcher. Optional: without them the install still works, but cannot read
  references out of `~/Documents`, `~/Desktop` or `~/Downloads`.

Nothing is downloaded: no `npm install`, no `node_modules`. Two rendering engines
(`marked`, `prismjs`) are vendored as readable source under `src/vendor/`, pinned by
sha256, and run server-side at post time. Mermaid is the one view-time load, from
jsdelivr, when a diagram renders.

### What it touches

About seven places, all under your home directory:
`~/Applications/claude-board.app` (the launcher), `~/Library/LaunchAgents/claude-board.plist`
(the launchd job), `~/Library/Application Support/claude-board/` (the board store, your
review history), `~/.config/claude-board/secret` (the local auth secret),
`~/.claude/skills/claude-board/` (the manual Claude Code reads),
`~/Library/Logs/claude-board/` (logs), and Claude Code's own MCP registration
(`claude mcp add`). No sudo, no network beyond a loopback health check.

A plugin install adds an eighth: `~/Library/Application Support/claude-board-checkout`,
a code copy `install.sh` makes and re-runs from. Claude Code sweeps old plugin versions
from its cache, so nothing durable may point into it. The plugin itself registers no
MCP server and no manual: a plugin-registered server would rename the `ask` tool, so
`install.sh` stays the single registrar either way.

### Updating

The clone is a build input, not what the daemon runs. A `git pull` or a plugin update
changes nothing on its own; run `bash install.sh` or `/claude-board:install` again to
take it. Idempotent: nothing that already matches is rebuilt, which is what keeps the
permission clicks below from being asked again.

### The one click: folder access

macOS gates `~/Documents`, `~/Desktop` and `~/Downloads` per application. The installer
builds `~/Applications/claude-board.app`, a small signed launcher that runs the daemon,
and macOS asks once whether *that* may read the folder. The grant belongs to the
launcher alone, never to `node` itself, the same permission with a vastly wider blast
radius ([SECURITY.md](SECURITY.md#defended)).

Refusing is a real option: everything works except references into those three folders,
which render as `cannot read <path>: EPERM`. Reversible either way under
**System Settings → Privacy & Security → Files and Folders**.

### The second click: notifications

The launcher posts the two notifications claude-board raises: a pomodoro boundary, and
a round left waiting on a board nobody is looking at. macOS asks once, at the end of
the install rather than hours later. Saying no costs the notifications and nothing
else. Each has its own switch beside the clock on the index page. Both arrive as
banners by default, gone in seconds; set claude-board to **Alerts** under
**System Settings → Notifications** to make them wait for you.

### The menu bar item and the timer

Installing also adds a menu-bar status item: quick access to the boards still waiting
on an answer, so an open question is never further away than the clock. The item also
carries an optional pomodoro-style work timer, **off by default** — installing
claude-board does not start a timer, add one to the index page, or notify you about
one. To opt in, flip the **Pomodoro timer** switch that leads the board's settings
panel: the timer then appears on the menu-bar item and the index page's clock. Even
switched on it starts nothing by itself; a timer starts only from the index page, or
from the optional session-start hook in [INSTALL.md](INSTALL.md), which is applied by
hand because `install.sh` never touches `~/.claude/settings.json`. Hide the icon
entirely with **Show in menu bar** in the board's pomodoro settings, independent of
the timer switch; the choice survives logout and reinstall.

### Stopping without uninstalling

`launchctl bootout gui/$(id -u)/claude-board` unloads the launchd job. It comes back on
next login, or on `bash install.sh`. Actual removal is `bash uninstall.sh` (below).

## Use

`install.sh` copies [`skills/claude-board/SKILL.md`](skills/claude-board/SKILL.md) into
`~/.claude/skills/claude-board/`, where Claude Code picks it up on its own, so asking
the agent to put its questions on the board is enough. Any command, skill or session
can also call the tool directly:

```js
mcp__claude-board__ask({ title, blocks, wait, fresh })
```

`title` and `blocks` are required; `wait` and `fresh` are optional booleans. `fresh`
starts a new board instead of adding a round to the one this conversation already has
open; [`SKILL.md`](skills/claude-board/SKILL.md) has the exact rule for when to pass
it. [PROTOCOL.md](PROTOCOL.md) is the wire format underneath.

A tab opens on the first call. Answer what you want; unanswered comes back explicitly
marked, never defaulted. Add a note beside any answer, or click **comment mode** and
click any element of a rendered diagram or artifact to attach a comment to it, then
**Send**. Follow-up rounds push into the same tab as new pages.

Two other ways out: **Discuss in chat** returns immediately with whatever is filled in,
and a wall-clock cap (default 40 minutes) returns an explicit no-response. Closing the
tab is deliberately *not* a cancel; the board stays live and its URL reopens it.

An artifact posted on its own returns the moment it lands, since nobody is asked to
answer it. Pass `wait: true` to hold the call open instead: the page gains a send
control, and its comments come back in that same call. If the cap runs out first,
anything typed and not yet sent is filed to the board and reaches whichever agent asks
next.

`http://127.0.0.1:7391/` lists every thread with its rounds-left count, filtered by
title, project folder or thread id. Searching *inside* archived boards is
`GET /api/search?q=`.

Content blocks reference a file rather than quoting it, and the daemon snapshots the
file at post time.

### An example skill

[`skills/grill-example/SKILL.md`](skills/grill-example/SKILL.md) is a design-interview
skill that posts each round of open questions as a board, adapted from
[Matt Pocock's `grill-me`](https://github.com/mattpocock/skills/tree/main/skills/productivity).
It is not installed. `install.sh` copies the manual and nothing else, and the plugin's
`skills` override hides this directory from plugin discovery the same way it hides the
manual — so nothing here registers a `/grill-example` until you copy it yourself:

```sh
cp -r skills/grill-example ~/.claude/skills/                                  # from a clone
cp -r ~/Library/Application\ Support/claude-board-checkout/skills/grill-example \
      ~/.claude/skills/                                                       # from a plugin install
```

Worth reading before writing your own: it shows what a skill built on the board owns
(when a round goes up, what context rides with each question) and what it defers to the
manual (the call, the block kinds, the widgets), which is the split that keeps a caller
from drifting.

### If a page says "this browser is not authorized"

Boards are served only to a browser claude-board has handed a credential to. The tab a
session opens is authorized automatically, and its URL carries no credential, so reload
and bookmark it freely. Any other browser (cleared cookies, another profile) gets a
page that prints the `authorize.mjs` command with the right absolute path for your
machine. It opens an authorized tab and touches nothing else. Add `--print` for a link
to paste elsewhere, or a board id to land on that board.

## How it works

- **A daemon** on `127.0.0.1:7391`, always on under launchd, owns the browser surface
  for every session on the machine.
- **A stdio MCP server** per session hands boards to it and blocks on the answer,
  emitting progress notifications so the call is never idle-aborted. Claude Code
  backgrounds it after roughly two minutes, so your session stays interactive.
- **JSON is truth.** A board is a JSON document and the page is a pure function of it.
  An archived board double-clicked from Finder renders read-only with no daemon
  running, as long as its folder comes too: the page names the shared script and
  stylesheet beside it rather than carrying its own copy
  ([`examples/sample-board.html`](examples/sample-board.html) is one; `open` it from a
  clone). Re-rendering old boards after a design change is a loop over the store, not a
  migration.

Boards live outside this repository, under
`~/Library/Application Support/claude-board/` (override with `CLAUDE_BOARD_HOME`), so
review content is never committed.

## Uninstall

```sh
bash uninstall.sh
```

Removes the launchd job, its plist, the MCP registration, the launcher bundle with its
LaunchServices record, and the installed manual. It names what it deliberately leaves:
the store, the secret, the logs. Safe to run twice, and on a machine that never had it.

From a plugin install with no clone around:
`bash ~/Library/Application\ Support/claude-board-checkout/uninstall.sh` (it removes
the checkout too, itself included), then `/plugin uninstall` and
`/plugin marketplace remove` take back what Claude Code holds.

One leftover no script can remove: the `claude-board` entry under
**Files and Folders** in System Settings. The bundle it refers to is gone, so it grants
nothing, but macOS offers no way to delete it programmatically.

## Development

```sh
npm run check      # the full suite, node only, no browser and no network
```

**Take a code change with `./install.sh`, never `launchctl kickstart`.** The daemon
runs a copy staged inside the launcher bundle, so a kickstart bounces it visibly while
it goes on running your old code. Reserve kickstart for reviving an unresponsive
daemon.

The interactive layer (drag-to-rank, click-to-comment, notifications, live hydration)
is verified by hand, not by the suite. [QUIRKS.md](QUIRKS.md) records every green check
that sat on top of a dead feature, and why the suite missed it.

The project-management docs live at the root, in the open: [QUIRKS.md](QUIRKS.md)
(tooling traps), [PROTOCOL.md](PROTOCOL.md) (the wire contract), [DESIGN.md](DESIGN.md)
(the reasoning behind [ADR.md](ADR.md)'s decisions), [CONTEXT.md](CONTEXT.md) (the
project's vocabulary) and `.agents/adr/` (one file per decision). Written for whoever
touches this code next, human or agent; read them before fighting a tool here.

## License

MIT. See [LICENSE](LICENSE).
