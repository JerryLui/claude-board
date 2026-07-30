# Changelog

Notable changes to claude-board. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project does not yet follow semantic versioning, because nothing has been released.

## [Unreleased]

### Changed

- The store default moved from `~/Documents/renders/board` to
  `~/Library/Application Support/claude-board`. `CLAUDE_BOARD_HOME` is now documented as
  configuration rather than as a test seam. No migration: there is no installed base.

### Added

- README, license, this changelog, `SECURITY.md`, and CI running the check suite.

### Known issues

- Read routes are unauthenticated; see [SECURITY.md](SECURITY.md#open). Being closed
  before release.
- No uninstall script. Manual steps are in the README.
- `install.sh` does not install the `/grill` command file; copy it by hand.
- The plist's `WatchPaths` is inert: it coexists with `KeepAlive`, and launchd only uses
  a watch to *start* a job that is not running. Editing `src/` or `bin/` therefore does
  not reload the daemon — `launchctl kickstart -k gui/$(id -u)/claude-board` does.

## 0.1.0 — unreleased

The initial build. A daemon, an MCP server, a board, and `/grill` on top of it.

### Added

- **The board.** An ordered list of blocks — `markdown`, `mermaid`, `code`, `html`,
  `compare`, `question` — served as one page. Four answer widgets (single-choice cards,
  multi-select, free text, drag-to-rank), each with an optional note, plus an explicit
  unanswered state that comes back marked rather than defaulted.
- **A blocking MCP `ask` tool.** One stdio server per Claude Code session, holding the
  call open until you submit, with progress notifications so the idle timer never fires.
  Three ways out: Send, Discuss in chat (returns partials and tells the agent to stop
  posting boards), and a wall-clock cap.
- **Rounds in one thread.** Follow-up rounds push into the live tab over SSE; the sent
  round collapses into a history rail with its answers still readable, and an open round
  can be amended without disturbing fields already filled in.
- **Click-to-comment on any element**, behind a comment-mode toggle. Rendered prose, a
  list item, a table cell, a line of a code reference, a hand-mocked stage, a diagram
  node, one side of a comparison and a question's own widget all take a comment; the
  packet names a DOM path with a text hint, or a mermaid node id.
- **JSON is truth.** The page is a pure function of the board document, emitted with its
  source inlined, so an archived board opens read-only from Finder with no daemon.
  Content is referenced by path, resolved and snapshotted at post time, so a board
  survives its source being rewritten or deleted.
- **An index** listing every thread with pending counts, searchable across archived
  boards.
- **`install.sh`**, idempotent: local secret, launchd job with `KeepAlive` and
  `WatchPaths`, a health check that refuses to report success on a daemon that never
  bound, and MCP registration at user scope.
- **17 checks**, node only, no browser and no network, each under a deadline in its own
  process group.

### Security

Found by internal audit during the initial build, all fixed and covered by checks:

- Cross-origin writes were possible. A loopback `Host` check does not stop a page doing
  `fetch('http://127.0.0.1:7391/…')`, because the browser sets a loopback `Host` itself,
  and both POST routes were CORS simple requests, so no preflight could block them. Added
  an origin check.
- Any local process could have the daemon resolve and serve a file it named, laundering
  that read past macOS TCC. Added the local secret, required on writes and on anything
  that resolves a path.
- Board ids were 4 random bytes, enumerable locally in seconds. Now 16.
- Amending a round could rewrite blocks belonging to an already-sent round, laundering a
  prior consent onto a new prompt.
- `sandbox="allow-same-origin allow-scripts"` on the HTML stage iframe is not a sandbox;
  the stage is now genuinely isolated, with the parent refusing to trust messages from it.
- Attribute values in the markdown renderer, and caller-supplied block ids flowing into
  client-side selector strings, were unescaped in places.
- Repeated SSE pushes re-wired already-wired DOM, duplicating listeners.

### Fixed

Three separate occasions where the checks were green while the feature was completely
dead — twice from asserting structure instead of behaviour, once from mocking mermaid's
id scheme wrongly. Click-to-comment inside a stage attached its listeners to an iframe's
`about:blank` placeholder document; diagram anchoring matched `^flowchart-` while real
mermaid namespaces node ids with the diagram's own svg id. Both fixed, and the harness
now exercises the click path end to end against a DOM stand-in rather than asserting on
rendered strings.
