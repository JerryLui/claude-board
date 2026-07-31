# Changelog

Notable changes to claude-board. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project does not yet follow semantic versioning, because nothing has been released.

## [Unreleased]

### Security

- **Read routes now require a credential.** The index, a board page, archive search, the
  blocking wait and the event stream all refuse a caller holding neither the local secret
  nor the browser session cookie, with **401**. Only `GET /api/health` stays open, because
  `install.sh` polls it with plain `curl` to decide whether the service came up. Before
  this, any process that could open a socket to the port read every board — source
  excerpts, questions and answers included.
- **The browser is authorized by a single-use handoff, never by a token in a URL.** The
  session's shim asks the daemon for one (`POST /api/handoff`, secret required), opens it,
  and the daemon consumes it, sets a host-only `HttpOnly` `SameSite=Strict` cookie and
  redirects to the clean board URL. The handoff lives about 30 seconds and dies on first
  use; expired, spent and invented tokens are refused identically. The cookie is derived
  from the secret, so it survives a daemon restart and rotating the secret revokes every
  browser at once.
- **The board-scoped submit token is deleted.** `POST /api/board/:id/submit` accepts the
  session cookie or the secret and nothing weaker. It existed only because reads were
  open; with reads gated it was strictly weaker than the credential a reader had already
  presented.

### Changed

- The store default moved from `~/Documents/renders/board` to
  `~/Library/Application Support/claude-board`. `CLAUDE_BOARD_HOME` is now documented as
  configuration rather than as a test seam. No migration: there is no installed base.
- `GET /b/:id` no longer sets any cookie. The served page's bytes stay a pure function of
  the board JSON, so the standalone archive is unchanged and still opens from disk with no
  daemon and no credential.

### Added

- README, license, this changelog, `SECURITY.md`, and CI running the check suite.
- **A light theme.** Follows the OS `prefers-color-scheme` by default, with a header
  control that cycles System → Light → Dark; the choice is remembered in
  `localStorage` per origin, applied before first paint so there is no dark-then-light
  flash. A standalone archive always follows the OS and remembers nothing.
- `bin/authorize.mjs` (`npm run authorize`), the recovery command: it mints a handoff and
  opens an authorized tab for a browser holding no credential — a cleared cookie jar, a
  second profile, a different browser — without reinstalling, restarting the service or
  touching the store. `--print` emits the URL instead. Every refusal page names this
  command with an absolute path.
- `install.sh` now installs `/grill` itself, to `~/.claude/commands/grill.md` — the
  board's only caller, previously a manual `cp` step in the README. Idempotent: an
  unmodified copy is overwritten with fixes, but a copy the user has edited is left
  alone, with install saying so and continuing rather than dying. "Unmodified" is
  decided by a sha256 recorded at install time, kept beside the local secret in
  `~/.config/claude-board/`.
- `uninstall.sh`, symmetric to `install.sh`: removes the launchd job, its plist, the
  MCP registration, and the installed `/grill` command file (unless it has local
  edits, which it leaves and says so), then reports exactly what it leaves behind on
  purpose — the store, the local secret, and the logs, named by path. Safe to run when
  nothing is installed and safe to run twice.

### Fixed

- The plist's `WatchPaths` never restarted the daemon: it coexists with `KeepAlive`,
  and launchd only uses a watch to *start* a job that is not running, so editing `src/`
  or `bin/` did nothing. Replaced with a mechanism that composes with `KeepAlive`
  instead of fighting it: `bin/daemon.mjs` now watches its own `src/` and `bin/` and
  exits on a change, and `KeepAlive` brings it straight back up. Opt-in via
  `CLAUDE_BOARD_RELOAD_ON_CHANGE=1`, which only `install.sh`'s generated plist sets, so
  nothing else that spawns the daemon (the check suite, running it by hand) self-exits
  on an unrelated file event. `WatchPaths` is gone from the generated plist. launchd
  will not restart a job more than once per 10s, so two edits inside one 10s window
  collapse into a single restart. See [QUIRKS.md](QUIRKS.md).

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
