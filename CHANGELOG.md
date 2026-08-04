# Changelog

Notable changes to claude-board. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project does not yet follow semantic versioning, because nothing has been released.

## [Unreleased]

### Added

- **A tab mark.** The board, the index and the refusal page all emit the same inline
  `data:image/svg+xml` favicon (a board with two quiet rows and one emphasised row),
  painted from the dark palette so it never drifts from `--accent`, and inline so the
  standalone `file:` archive shows it with the network off. Clearing the pending-round
  badge now restores that mark instead of leaving the tab blank, and the badge itself
  is drawn in the real accent rather than the two-edits-stale blue it had been using.
- **An `html` block can carry a `source` instead of the markup itself.** `{ kind: 'html',
  source: { path } }` resolves through the same reader, confinement, 512 KiB cap and sha
  snapshotting as `markdown`, `code` and `mermaid`, with the same block-level `error` on a
  failed resolve. `html` was the one kind stuck by value, on the reasoning that a
  hand-mocked stage has no file to point at — that stopped holding once agents started
  rendering real pages to disk, where the only way onto a board was re-emitting the whole
  file as generated tokens (~25-30K of them for one 80 KB document). One exception: `lines`
  and `section` are refused with a block-level error naming markup slicing as the reason,
  because cutting markup at a line boundary yields unclosed tags and orphaned `<style>`
  where cutting text the same way still yields text. See ADR.md entry 7.

### Fixed

- **A CRLF markdown file no longer wedges the daemon.** `.` and `$` do not match `\r`, so
  a line like `- alpha\r` passed the list guard, failed the item pattern, matched no
  continuation and broke out of the item loop without advancing the line index — an
  infinite loop that pinned a core and stopped the daemon answering anything, `launchd`
  included, since the process stayed alive. Triggered by an ordinary CRLF file in the
  project, by value or by reference, with no attacker involved. Headings in such a file
  also yielded no anchors, so every `section:` ref against one reported "not found". Both
  passes now strip a trailing CR, and the list loop always makes progress.
- **Duplicate-slug disambiguation is no longer quadratic.** Every duplicate re-probed from
  `-2`, so N headings sharing a base cost O(N²): 512 KiB of `# a` took 10.5 minutes in
  `mdToHtmlAndAnchors` and 8.8 minutes in `sliceSection`, inline on the request. Both now
  carry an ordinal map beside the used-slug set; the same input takes ~0.2s and ~0.08s.
  Output is unchanged.
- **A nested block can no longer claim a top-level block's id.** The check asked where the
  id's existing owner sat, never where the claiming block sat, so a question nested in a
  `compare` side or another question's `context` could name a live top-level id.
  `amendRound` splices on top-level ids only, so it appended instead of substituting and
  two live blocks shared one id — `answers` is keyed by id, and the packet reported the
  reviewer's single choice against both prompts.
- **A repeated round is no longer answered from the previous one.** The idempotency key is
  derived from a round's content and `lastRequestId` was never cleared, so the ordinary
  fix-and-reconfirm loop posted a byte-identical body and was treated as a lost-response
  retry: no round was created and `/wait` returned the earlier round's answer in
  milliseconds. The guard is now scoped to the round it protected.
- **A block id with an implausible ordinal is refused.** Past 2^53 the mint counter stops
  incrementing, so the re-mint loop never terminated — and the board persisted before the
  spin, so the stored file re-wedged the daemon on every later `ask`.
- **Deep agent markup no longer 500s the reviewer's Send.** `elementText` recursed and threw
  `RangeError` out of a parser documented as never throwing; it is now iterative.
- **`<` inside a quoted attribute no longer drops an element.** It is an ordinary character
  there per the HTML parsing spec, but the tokenizer ended the tag early, shifting every
  later sibling index — reporting live anchors lost, or resolving against the wrong element.
- **Latin-1 letter entities decode.** `G&aring;r vidare` left the server holding the literal
  text while the browser read `Går vidare`, so a live element was reported lost.
- **A `timeout` packet is no longer reported as "Board submitted."** The daemon-side cap
  produced answers that were all synthesised `unanswered` on a still-open round, and the
  shim rendered it as a completed review.
- **"Discuss in chat" survives a concurrent round.** The packet read the board-wide state,
  which `addRound` resets to `open`, so a second `ask` landing inside the waiter's poll
  erased the reviewer's decision. The outcome is now recorded on the round.
- **`cwd` sent alongside `boardId` is refused rather than ignored.** The value was never
  forwarded, so the documented 400 could not fire and the caller got a 200.
- **The index counts nested questions.** `pendingCount` walked top-level blocks only, so a
  board whose only question sat in a `compare` side and was explicitly deferred showed
  "0 pending".
- **Option and prompt fields are size-capped**, and stored anchor strings are bounded. Both
  were limited only by the 25 MB body cap; an oversized `preview` additionally fed a
  quadratic URL sniff (now a parse), and an oversized anchor `ref` made every render of
  that board cost seconds, permanently, because comments are append-only.
- **Short writes cannot publish a truncated board.** `writeSync` issues one `write(2)` and
  returns a partial count without throwing; the store now loops.
- **`CLAUDE_BOARD_HOME` reaches the daemon.** It is documented configuration, but was never
  written into the launchd plist, so a redirected store silently stayed at the default path.
  The installer now propagates and prints it.

### Security

- **A rendered variant cannot pick itself.** The new `choose-between-rendered-variants`
  widget renders each option as a real block, which may be an HTML stage — agent-authored
  script inside the control the reviewer decides with. Inside an option's card that iframe
  is `pointer-events: none`, so the selecting click lands on the card in the parent
  document, and no stage-to-parent message can select anything. An earlier draft of the
  widget did give stages a `select` message, and it was removed before merge: origin and
  frame-identity validation proves a message came from *a stage*, never that *a human*
  acted, so a mock that clicks itself — or one that simply posts the message — would have
  answered the reviewer's question for them.
- **Read routes now require a credential.** The index, a board page, archive search, the
  blocking wait and the event stream all refuse a caller holding neither the local secret
  nor the browser session cookie, with **401**. Two routes stay open: `GET /api/health`,
  because `install.sh` polls it with plain `curl` to decide whether the service came up,
  and `GET /auth/<token>`, which is the route that hands out the credential and so cannot
  require one. Before this, any process that could open a socket to the port read every
  board — source excerpts, questions and answers included.
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
- **The reference allowlist's default was too wide, and is narrowed.** References can
  now resolve inside a configured allowlist (`CLAUDE_BOARD_REF_ROOTS`) as well as a
  board's own `cwd`, so a session can render the skill, command or agent file it is
  actually discussing instead of showing a refusal box. An internal audit found the
  shipped default, the whole `~/.claude` tree, resolves the CLI's own credentials file,
  its full prompt history and every project's session transcripts alike -- all of it
  readable through a board, snapshotted into it, and full-text searchable from `/`
  forever. The default is narrowed to three roots, `~/.claude/skills`,
  `~/.claude/commands` and `~/.claude/agents`; `CLAUDE_BOARD_REF_ROOTS=~/.claude` still
  opts back into the whole tree for anyone who wants it. See ADR.md entry 3.

### Removed

- **The daemon no longer restarts itself when its source changes.** `install.sh` stops
  setting `CLAUDE_BOARD_RELOAD_ON_CHANGE=1`, and `bin/daemon.mjs` no longer watches
  `src/` and `bin/` at all — the variable is read nowhere, so a stale plist or an
  exported shell value does nothing. The mechanism worked; it was the wrong thing to
  want. A save during a review dropped every open event stream and every held-open wait,
  editor temp files counted as changes, launchd's 10s restart throttle turned a burst of
  writes into a visible outage, and a half-written edit could take the daemon down for
  real. Updates are taken by re-running `./install.sh` (or `launchctl kickstart -k
  gui/$(id -u)/claude-board` for a plain restart), at a moment somebody chose.

### Fixed

- **Running the check suite deleted the developer's own launcher bundle.**
  `test/check-install.mjs` redirects everything `install.sh`/`uninstall.sh` touch into a
  temp directory, and one env object was missing `CLAUDE_BOARD_APP_DIR`: `uninstall.sh`
  fell back to `$HOME/Applications` and `rm -rf`'d the real
  `~/Applications/claude-board.app`. The daemon then died with launchd's "Missing
  executable" (`exit 78`, and a `kickstart` that hangs rather than saying why), and the
  TCC grant pinned to that bundle's signature went with it — while the suite reported
  all green. The seam is added, and a final check now asserts the real bundle, plist and
  secret are exactly as the suite found them, so the next spawn that forgets a seam is
  caught whichever seam it forgets.

### Changed

- **Opening a live thread from the index lands on the round still owed an answer.** A row
  whose board has an open round links to `#open-round`, a sentinel the board page resolves
  through the same jump the round badge and the notification click already use — one
  definition of "the thing that needs an answer", not one per entry point. A thread several
  rounds deep used to open at round 1, history the reviewer had already sent, and made them
  scroll past all of it. Deliberately not a per-round element id (`#round-3`): board content
  is markdown snapshotted from arbitrary files whose headings mint ids on the same page, so
  a `## Round 3` heading would hijack a native fragment jump. A settled thread keeps the
  bare link — nothing is open, so there is nowhere to jump to.
- **A board notification is now one entry per round, and clicking it opens the tab.** The
  `tag` carries the round number (`claude-board-<boardId>-<n>`) instead of the board id
  alone, so rounds 2 and 3 arriving at a tab you are not looking at leave two entries in
  Notification Center rather than the second silently replacing the first; only a genuine
  re-delivery of the same round still collapses. A click on the notification focuses the
  board's tab, scrolls to the round waiting for an answer, and dismisses itself — the one
  place the page may pull itself forward, because the click is the reviewer asking for it.
  The jump is the round badge's, shared rather than reimplemented: clicking a notification
  asks the same question the badge answers, and landing on whatever you had last scrolled
  to made you ask it again by hand. Permission is also requested when you press
  **Send**, which is the one click guaranteed to happen on a focused tab: the previous
  sole request site was the hidden-tab branch, where Chrome queues the prompt instead of
  raising it, and a reviewer who dismissed that queued prompt was stranded at `default`
  with no other way back. Still never requested at page load, still never re-prompted
  after a denial, and still inert in the standalone `file:` archive.

- **The daemon now runs under a launcher bundle of its own, so macOS can grant it a
  folder without granting `node` one.** `install.sh` compiles `bin/launcher.c` into
  `~/Applications/claude-board.app` (ad-hoc signed, `io.github.jerrylui.claude-board`)
  and the launchd plist runs that instead of `node bin/daemon.mjs`. Without it, TCC has
  only `node` to decide about, and every board reference into `~/Documents`, `~/Desktop`
  or `~/Downloads` failed with `cannot read <path>: EPERM` — indistinguishable, from the
  reviewer's side, from a missing file. The alternative was asking users to hand their
  Documents folder to every node program on the machine, in a grant that `brew upgrade
  node` then silently revokes.

  What this means in practice: **a first install now asks you to click Allow once**, and
  if your clone lives in one of those three folders the daemon cannot start until you
  do (the installer waits, and says why). A reinstall does not ask again — the bundle is
  rebuilt only when something it is built from actually changed, because TCC pins the
  grant to the code signature and a needless rebuild would revoke it silently. Building
  the launcher wants `cc` from the Xcode Command Line Tools; a machine without them
  still installs and runs, minus the ability to read those three folders, and says so
  rather than failing. `uninstall.sh` removes the bundle. See SECURITY.md "What the
  launcher bundle is for" and QUIRKS.md.
- The store default moved from `~/Documents/renders/board` to
  `~/Library/Application Support/claude-board`. `CLAUDE_BOARD_HOME` is now documented as
  configuration rather than as a test seam. No migration: there is no installed base.
- `GET /b/:id` no longer sets any cookie. The served page's bytes stay a pure function of
  the board JSON, so the standalone archive is unchanged and still opens from disk with no
  daemon and no credential.
- **`install.sh` no longer installs `/grill`, or any other command, and `uninstall.sh` no
  longer removes one.** Both briefly did, back when `/grill` was the board's only caller
  and this repo had written it. `SPEC_MIGRATION.md` grew five more callers this repo did
  not write and asked whether they should move in too; the answer was no, for any of them
  — `claude-board` ships the daemon, the shim and the protocol, and nothing that calls
  them. `commands/grill.md` is deleted from this repo and lives only at
  `~/.claude/commands/grill.md`, versioned on its own schedule. See ADR.md entry 5.

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
- `uninstall.sh`, symmetric to `install.sh`: removes the launchd job, its plist, and
  the MCP registration, then reports exactly what it leaves behind on purpose — the
  store, the local secret, and the logs, named by path. Safe to run when nothing is
  installed and safe to run twice.
- **References can resolve inside a configured allowlist, not just a board's `cwd`.**
  `CLAUDE_BOARD_REF_ROOTS` (colon-separated absolute paths) is validated exactly as
  `cwd` already is -- realpath'd, must exist, refused if it is `/` or `$HOME` or
  above -- and a root that fails is dropped rather than widening the gate or taking
  the daemon down. An explicitly empty value restores the old `cwd`-only boundary, and
  `install.sh` writes the resolved value into the plist. See the Security entry above
  for the default this shipped with and why it was narrowed.
- **A queued comment can be edited and deleted before Send.** Clicking an
  already-commented element in comment mode reopens and edits its queued comment
  instead of minting a duplicate, across every anchor-minting path (the page-wide
  click listener, the html-stage's own click handler, and the mermaid block's own).
  Each queued entry gets a delete control; deleting one renumbers every remaining
  entry from its position, not just within one block. An element that already
  carries a SENT comment is inert in comment mode: click does nothing, and hover
  shows `cursor: not-allowed` instead of the ordinary anchor affordance, now in the
  dom, mermaid and html-stage paths alike.
- **A code block's height is capped, with an internal scroll and a drag handle.** A
  long reference now scrolls inside its own box (~480px, the same idiom
  `.html-stage` already used) instead of pushing everything below it off-screen; a
  short one is unaffected. The cap converts to a plain, breakable height the moment
  a drag actually needs more room, and the code block's pin layer is clipped to the
  `<pre>`'s own box, so a pin for a line scrolled out of view is hidden rather than
  drawn in the wrong place.
- **The round badge tracks your position, and a back link leaves the board.** The
  header now reads "round N of M": N is the round currently crossing the sticky
  header line, tracked with `IntersectionObserver`, M is the board's round count.
  Clicking the badge jumps to the round still open for an answer. A back-to-index
  link sits in the header too, absent (not merely disabled) under a read-only
  archive, since a `file://` load has no daemon behind `/` to reach.
- **A diagram opens in a pan/zoom lens you can comment inside.** A mermaid block's
  kicker carries an expand control that opens the diagram full-viewport: drag pans,
  scroll zooms about the cursor, fit and 1:1 reset the view. A node commented on
  from inside the lens is the same comment as one minted inline -- the anchor, the
  queued-comment edit and the sent-comment de-affordance are shared, not separately
  implemented -- and pan/zoom stay usable read-only in a standalone archive.
- **The index leads with the thread's title, not its project path.** A row's
  headline is the board title now; a title-less board falls back to the project's
  folder name (basename only, full path on hover via a `title` attribute), and a
  board with neither falls back to a plain label rather than the literal word
  "untitled". The round count sums across a thread's whole board-doc group, not
  just the primary board's, and the updated timestamp reads as relative time ("an
  hour ago"), refreshed by a small inline client script, with the exact ISO value
  kept on the element's `title` attribute for hover.

### Fixed

- The 401 refusal page now reads the real palettes instead of a hand-copy, so it matches
  whatever board it sits in front of. It shipped dark-only — six hardcoded hex, no light
  variant — which put a black slab in front of a light-mode reader on the one page they
  reach holding nothing else. Adding a light variant by hand fixed the half that had been
  looked at and left the dark half on its original literals, none of which were a value in
  either palette, so the mismatch simply moved. `renderRefusalPage` now emits both token
  blocks from `src/styles.mjs`'s `palettes` at render time and paints every rule through a
  `var()`. The page stays self-contained — no stylesheet link, no script, no network, same
  locked-down CSP as a board — because self-containment ruled out *linking* the stylesheet,
  never reading the same data. The OS preference remains the only theme signal it can act
  on: the saved override lives in `localStorage`, behind the boot script this page
  deliberately does not carry. The raw-literal check that guards `src/styles.mjs` now runs
  against this stylesheet too. See [QUIRKS.md](QUIRKS.md).
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
- The diagram lens's own comment gesture was dead in every real browser: taking
  `setPointerCapture` on `pointerdown` (copied from `/explain`'s lens, the model for
  this one) makes the browser retarget the following `click` at the capture element,
  so a click on a node reached the handler as a click on the lens surface and
  commented on nothing. Invisible to the DOM stand-in, which has no such thing as
  pointer capture, and found only by driving the lens in real Chrome. The capture is
  now taken only once a press has actually become a pan, never on the press itself.
  See [QUIRKS.md](QUIRKS.md).
- Three title-less threads sharing one project directory rendered as identical rows:
  the folder-name headline fallback and the suppressed path line both collide on the
  same text, and nothing else on the row varied. A row now always carries its thread
  id as a visible discriminator, not only in an attribute nobody reads.
- The index row's round count summed across every board doc behind a thread, which
  could show a round number that exists on neither board: a two-board thread (2
  rounds each) read "round 4" and linked to a board whose own header read "round 1
  of 2". `src/badge.mjs`'s own doc comment records the board page's version of this
  exact mistake. The row now states the count of the specific board it links to,
  worded as a count ("2 rounds"), never as an ordinal ("round 2"), and the segment
  is omitted rather than reading "0 rounds" for a board with no rounds at all.
- The relative-time client script (`relTime`) thresholded the raw, unrounded time
  difference and rounded only for display, so a value that rounds up to the next
  tier's boundary still printed in the tier below it for one more tick: 44m59s
  read "45 minutes ago", and one second later, 45m00s, read "an hour ago". Now
  rounds each unit first and thresholds the rounded value (moment.js's own
  approach), which removes states like that entirely. Also: a `null` timestamp
  returned "54 years ago" instead of being left alone (`new Date(null).getTime()`
  is `0`, not `NaN`, so the previous guard missed it), and the refresh interval
  polled slower (60s) than its narrowest bucket is wide (45s), so a row could load
  at an offset that skipped "a minute ago" entirely; now 15s. See
  [QUIRKS.md](QUIRKS.md) for the check-suite gap that let the wiring itself (not
  just `relTime`'s own logic) ship unverified.
- Seven more client-side id lookups were still bare `getElementById`, all of them
  added after the sweep that tag-qualified the rest: the queued-comment list, the
  html-stage message guard's form lookup, the diagram lens's two adoption lookups,
  the comment-delete handler's target lookup, and the round badge twice. Board
  content is markdown snapshotted from arbitrary files, so a heading or top-level
  list item can mint any of those ids (including composed ones like
  `comment-form-q1`) and win tree order. Each now names the tag `src/render.mjs`
  actually emits — `div#comment-list-`, `form#comment-form-`, `div#comment-target-`,
  `button#round-badge` — and a sweep of all four client scripts fails if a bare
  lookup, or an unqualified `#id` selector, ever comes back.
- Switching theme while the diagram lens was open left a dark diagram inside light
  chrome (or the reverse): the lens holds a clone of the inline SVG, and a theme
  change replaces that SVG with a newly drawn one. The two features were built on
  separate branches, so nothing connected them. Reachable without touching the theme
  control at all — a modal dialog makes it inert, but the OS switching light/dark
  while the preference is System fires the same redraw. The open lens now re-clones
  from the redrawn diagram, keeping the reviewer's pan and zoom and its pins. See
  [QUIRKS.md](QUIRKS.md), which carried the now-corrected claim that the lens was
  "downstream of those variables ... nothing extra to keep in step".
- The html stage's hover outline — the only feedback telling you which element a
  click will anchor a comment to — sat at 2.61:1 against its background, under the
  3:1 minimum for non-text UI. The stage always renders on white (its background
  token is `#fff` in both palettes, because an agent-authored mock assumes a white
  canvas), but the outline was pinned to the *dark* accent, which the light palette
  had already rejected for exactly this reason when it moved `--accent` to the
  mid-blues. Now pinned to the light accent: 6.65:1, still one value for both
  themes. The checks now assert the contrast directly rather than "matches the
  token", which was the wrong requirement stated convincingly.
- The "this browser is not authorized" page had no light theme — a black slab on
  every light-mode machine, since the credential gate shipped. It carries no
  stylesheet and no script by design, so it now follows the OS preference, the only
  theme signal available to it.

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

Three separate occasions in this release where the checks were green while the feature
was completely dead — twice from asserting structure instead of behaviour, once from
mocking mermaid's id scheme wrongly. Click-to-comment inside a stage attached its
listeners to an iframe's `about:blank` placeholder document; diagram anchoring matched
`^flowchart-` while real mermaid namespaces node ids with the diagram's own svg id. Both
fixed, and the harness now exercises the click path end to end against a DOM stand-in
rather than asserting on rendered strings. More of the same family have turned up since
this release, in later work; [QUIRKS.md](QUIRKS.md) is the running register, not this
paragraph.
