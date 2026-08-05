# Changelog

Notable changes to claude-board. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project does not yet follow semantic versioning, because nothing has been released.

## [Unreleased]

### Security

- **The launcher no longer hands node the plist's environment unfiltered.** The
  `EnvironmentVariables` dict in `~/Library/LaunchAgents/claude-board.plist` is
  world-readable and user-writable, and a `NODE_OPTIONS=--require ...` key in it used to
  run chosen code inside the TCC-granted process with the bundle's signature untouched —
  no recompile, no re-sign, nothing to distinguish it from a knob an operator meant to
  tune. `bin/launcher.c` now builds the child's environment itself before `exec`ing node
  (`execve`, not `execv`): `HOME`, `PATH` (fixed to `/usr/bin:/bin:/usr/sbin:/sbin`, since
  the daemon shells out to `osascript` and `open` and an inherited `PATH` would be a
  code-execution path of its own), `CLAUDE_BOARD_HOME`, `CLAUDE_BOARD_REF_ROOTS` and
  `CLAUDE_BOARD_SERVE_ROOTS` — the five variables that decide what the daemon may read,
  serve and write — are compiled in at install time, the same way `CLAUDE_BOARD_NODE` and
  `CLAUDE_BOARD_DAEMON` already were. Retargeting any of them now costs a rebuild, which
  costs a re-sign, which costs the user's TCC grant and a fresh prompt — a deliberate
  trade, made explicit rather than left as an accident of how the launcher happened to be
  written. A short allowlist of timing and port knobs (`CLAUDE_BOARD_PORT`,
  `CLAUDE_BOARD_SHUTDOWN_MS`, `CLAUDE_BOARD_SSE_HEARTBEAT_MS`, `CLAUDE_BOARD_TIMEOUT_MS`,
  `CLAUDE_BOARD_HANDOFF_TTL_MS`, `TMPDIR`) still passes through by exact name, on the
  theory that none of them can change what directory the grant reaches. Everything else —
  `NODE_OPTIONS` chief among them, plus `CLAUDE_BOARD_SECRET_FILE`, which is deliberately
  on neither list, since a baked `HOME` already makes the daemon's own default secret path
  the only one it can reach — is simply never placed in the child's environment at all:
  not filtered out of something inherited, never put there in the first place. See
  SECURITY.md, "Fixed 2026-08-04: the environment used to be a third route, and the widest
  one", and `test/check-launcher-env.mjs`, which compiles the real launcher against a stub
  daemon and a poisoned parent environment — including a working `NODE_OPTIONS` marker —
  to prove the injected code never runs, not just that the string disappears.
- **`install.sh` stops writing the roots and the store into the plist once a launcher
  bundle is in use.** `CLAUDE_BOARD_REF_ROOTS`, `CLAUDE_BOARD_SERVE_ROOTS` and
  `CLAUDE_BOARD_HOME` used to be written into `EnvironmentVariables` unconditionally,
  which was already misleading the moment the fix above landed: the launcher ignores the
  plist for these regardless of what it says, so leaving them in was a lie about what is
  actually in force. They are omitted entirely now, present only on the degraded
  (no-launcher) path, where node reads its environment straight from the plist because
  there is nowhere else for it to come from. A previously-customised
  `CLAUDE_BOARD_REF_ROOTS` / `CLAUDE_BOARD_SERVE_ROOTS` is carried forward across a
  reinstall from a small record file next to the secret now, rather than read back out of
  the plist — the exact mechanism that used to let a written `NODE_OPTIONS` propagate
  silently across every future reinstall, and the one that stops working the moment the
  plist stops carrying the value at all. A pre-existing plist is still read once, as a
  migration, so an operator's earlier narrowing is not silently reset back to the default
  by the upgrade that fixed this.
- **The daemon's own code is now inside the signed bundle, not just the launcher that
  forks it.** `bin/daemon.mjs` and everything under `src/` used to live only in the
  clone — outside the ad-hoc signature and outside the rebuild stamp — so anything that
  could write the clone owned the TCC grant with no recompile and no re-sign.
  `install.sh` now stages a copy of both into `claude-board.app/Contents/Resources`
  before the existing `codesign` call, preserving `bin/`'s and `src/`'s relative layout
  so `bin/daemon.mjs`'s own `../src/server.mjs` import resolves unchanged. The rebuild
  stamp's input field folds in a deterministic digest of that payload — every file's own
  sha256 paired with its relative path, sorted before hashing, so it depends on content
  alone, never on mtime or directory-walk order — so an untouched reinstall still
  rebuilds nothing (the guarantee this whole change had to protect: a gratuitous rebuild
  costs the user their TCC grant), while editing `bin/daemon.mjs` or anything under
  `src/` in the clone now forces the next install to rebuild, where it silently would not
  have before. `bin/mcp.mjs` and `bin/authorize.mjs` are deliberately not staged — they
  are the shim, registered with Claude Code (or run by hand) at the clone's own absolute
  path, never through the launcher. One thing had to move to make this safe:
  `src/handoff.mjs`'s `recoveryCommand()` used to derive the clone's location from its
  own file location, which would have resolved inside the bundle and named a
  `bin/authorize.mjs` that does not exist there; a sixth compiled-in value,
  `CLAUDE_BOARD_REPO_ROOT`, now carries the real clone path instead, on the same footing
  as `CLAUDE_BOARD_NODE`. See SECURITY.md "Fixed 2026-08-04: the daemon's own code is now
  inside the signed bundle", ADR.md entry 15, and `test/check-install-payload.mjs`, which
  drives an edited throwaway clone's ALREADY-BUILT launcher to prove the old code is what
  answers before a reinstall and the new code after one.

### Added

- **The pomodoro notification comes from claude-board now, with claude-board's icon, and
  it can be made to stay on screen.** It used to be posted by `osascript`, which meant
  macOS attributed it to Script Editor: Script Editor's name on the banner, Script Editor's
  icon, and — the part that actually cost something — Script Editor as the only row in
  System Settings > Notifications you could switch from Banners to Alerts, which is the
  setting that decides whether a boundary vanishes after five seconds or waits until you
  dismiss it. All three come from the bundle of whichever process posts, and nothing can
  override them, so the fix was to post from `claude-board.app` itself: `bin/notify.m` (a
  `UNUserNotificationCenter` post) compiles into the launcher binary, `bin/launcher.c`
  gains a `--notify <phase>` mode, and `src/notify.mjs` spawns that mode when it can see it
  is running from inside the bundle. The bundle also gets an icon for the first time —
  `bin/claude-board.icns`, the amber board mark `src/styles.mjs` already draws as the
  favicon — which is what shows on the notification.

  Two one-time steps come with it, both of which the installer now walks you through: macOS
  asks once whether claude-board may notify you (`install.sh` triggers that prompt at the
  end of an install you are watching, rather than letting it appear hours later at a
  boundary), and making boundaries persist is still a manual toggle, because Banners versus
  Alerts is a per-app setting with no API — System Settings > Notifications > claude-board
  > Alerts. The `osascript` path stays exactly as it was for the no-launcher install, which
  has no bundle to post from. ADR entry 19, which amends entry 9: that entry accepted the
  Script Editor attribution as the price of never touching the launcher's signature, and
  entry 15 had already made that price unpayable by folding the daemon's own code into the
  same signature.
- **The daemon prints the environment it actually received, names only.**
  `claude-board env: NAME,NAME,...` — sorted, names only, never values — is the first
  line `bin/daemon.mjs` logs, landing in `~/Library/Logs/claude-board/daemon.out.log`
  (not a private log, hence names only). It is the seam that makes the launcher's new
  environment allowlist (see Security, above) checkable by reading a log line rather than
  by trusting the C source or booting under real launchd.
- **A pomodoro timer, owned by the daemon.** A Claude Code session starting begins a work
  interval; from there it is a self-sustaining loop — work rolls into break, break rolls
  into work — until you pause or reset it, and every fourth break is a long one. Each
  boundary fires a native macOS notification, so it reaches you with no browser tab open
  and no browser running (posted by the app bundle itself — see the entry above, which
  supersedes the `osascript` route this shipped with); sound, off by default, rode the
  same call as one generic tone (retired below into three per-phase cues, chosen rather
  than merely toggled). The index page carries the countdown, pause/resume and a settings
  panel for the three durations, the long-break interval, and — see below — a cue per
  phase in place of the old sound toggle.

  The daemon holds the clock rather than the browser — a deliberate departure from ADR 1's
  client-side-only precedent, on the grounds that a theme is a per-reader preference while
  a pomodoro is a single fact about the human (ADR entry 8). What it stores is the
  interval's **absolute wall deadline**, not remaining seconds, which is what makes a
  daemon restart invisible and what makes the sleep rule expressible at all: a deadline
  already past by more than 30 seconds is discarded silently instead of fired, so
  reopening a lid after four hours does not stack up reminders for breaks you took by
  being asleep.

  The timer is **advisory only**. No tool learns of it, no `ask` is delayed, blocked or
  annotated, and no board post is gated at a boundary — Claude works straight through it.
  There is no menu bar item, because the launcher bundle is ad-hoc signed and changing its
  bytes would cost the user their TCC Documents grant (ADR entry 9).

  The `SessionStart` hook that starts the loop ships as a documented snippet in
  `INSTALL.md`, applied by hand: `install.sh` reads and writes nothing under
  `~/.claude/settings.json` (ADR entry 5), and `uninstall.sh` leaves that snippet exactly
  where it found it while removing `pomodoro.json` from the store by exact name.
- **The board ships its own manual, and `install.sh` installs it.**
  `skills/claude-board/SKILL.md` states the `ask` tool once — call shape, every block kind and
  widget, the packet, and what to do when the board is unavailable — and step 6 copies it to
  `~/.claude/skills/claude-board/`. Callers name the skill and keep only what is theirs. It
  replaces 148 lines of protocol restated across six caller files, three of which had gone
  word-for-word identical; the drift that duplication had already produced is fixed with it
  (five of the six never relayed the recovery command the tool prints, and `/grill` documented
  four widgets for as long as there were five). Unconditional copy, no hash record, non-fatal
  if it fails: a daemon and a registration are the install. `uninstall.sh` takes the file back
  and leaves anything else in that directory alone. `CLAUDE_BOARD_SKILLS_DIR` seams the
  destination for tests. See ADR.md entry 11, which amends entry 5.
- **`test/check-skill-prose.mjs`** binds that manual to the live shim on every `node
  test/run.mjs` — the first time since entry 5 that this repo's suite proves any prose against
  its own mechanism. It checks for **absence** as well as invention: every block kind, widget
  and packet status `PROTOCOL.md` defines must appear in the manual, which is the check that
  would have caught the four-widget drift. Both directions covered, so it cannot go vacuous.

- **The daemon serves a rendered file at `GET /file/<path>`.** Bytes from a directory named
  in the new `CLAUDE_BOARD_SERVE_ROOTS`, back verbatim: no board chrome, no block, no slice,
  no cap, and no generated listing (a directory answers with the `index.html` already there).
  It exists so a board can *link* to a rendered document instead of embedding one — a whole
  page with a vendored diagram engine never fit in a 320px stage under a CSP naming no
  `'self'`. Absent means empty, so the route is off until `install.sh` writes the default
  (`~/Documents/renders`) or you name a directory yourself. Deliberately a **separate**
  allowlist from `CLAUDE_BOARD_REF_ROOTS`: a referenced file is escaped into a block, a served
  one is a live document at the daemon's origin, and one shared list would have widened every
  existing install on a `git pull`. Behind the read gate; every refusal is the same bare 404,
  so it cannot be used to probe the disk. Served responses carry their own CSP —
  `script-src 'self'` so the document loads its engine, `connect-src 'none'` and
  `form-action 'none'` so it cannot ride the same-origin session cookie into a submit. See
  ADR.md entry 10 and the SECURITY.md entry on what that CSP does and does not hold.
- **A tab mark.** The board, the index and the refusal page all emit the same inline
  `data:image/svg+xml` favicon (a board with two quiet rows and one emphasised row),
  painted from the dark palette (`--warning`, the one hue this palette holds at nearly the
  same value in either theme) so it never drifts from the tokens, and inline so the
  standalone `file:` archive shows it with the network off. Clearing the pending-round
  badge now restores that mark instead of leaving the tab blank, and the badge itself
  is drawn in the real accent rather than the two-edits-stale blue it had been using.
- **The pending-round mark on a tab lost its number, not its mark.** `document.title`
  no longer takes a `(n) ` prefix and the favicon no longer has a digit drawn on it —
  `setTitleBadge` is deleted outright rather than left assigning the base title back to
  itself. The favicon still shows a countless pip (the same two accent colours, no
  `fillText`) whenever a round is pending, and the Web Notification on a hidden or
  unfocused tab still names the round exactly as before. Knowing you owe an answer is
  worth a glance; knowing it's three answers wasn't worth a second mark that could drift
  out of sync with the round count.
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

### Changed

- **The pomodoro control is a switch, and it can start a timer.** One control now covers all
  three transitions — idle turns on and begins a work interval, running turns off and pauses,
  paused turns back on and resumes — so starting a pomodoro no longer means waiting for the
  next Claude session to trigger the hook. It replaces the Pause/Resume text button, which
  had no readable state and tried to disappear itself when idle. `POST /api/pomodoro/ensure`
  accepts the session cookie for this (ADR.md entry 17); it is the same route the session-start
  hook already calls, and `startWork` is a no-op against a timer that already exists, so
  starting one by hand while one runs still changes nothing.

- **The settings panel opens from a cogwheel, and closes when you are done with it.** The
  "Pomodoro settings" text link became an icon-only control (named for screen readers and on
  hover). Saving closes the panel; so does clicking anywhere outside it, which also disarms a
  half-confirmed Reset rather than leaving it armed for the next open. Save is the panel's one
  primary action and now wears the accent, like every other primary button in the product.

- **The index search box filters sessions instead of searching inside them.** A query narrows
  the thread list in place, matching a session's title, project folder or thread id; the
  block-level result cards that used to render beneath the list are gone, along with the
  full-text walk `GET /` ran to produce them. `GET /api/search` is unchanged and is still the
  full-text surface. See ADR.md entry 16.

- **The index title fills the header.** The "one thread per Claude session" subtitle is gone and
  the `h1` grew from 22px to 30px to take the space back. The header row centres its two sides
  now rather than top-aligning them, which had left the controls riding above the title's
  optical centre once the second line was no longer there.

- **The mark is an amber slab, and the pending state inverts it.** The tab tile moved from
  `--accent` to `DARK['--warning']` — the one hue the palette holds at nearly the same value
  in either theme, so a single tile now serves both instead of reading as the darkest thing
  on a light tab strip — with the rows fattened from 3.4 to 4.6/4.6/5.4 so the two quiet bars
  still separate after the downsample to 16px, and the corner opened from `rx 8` to `rx 9` to
  match. The countless pending mark is now that same tile with its two colours swapped (an
  amber pip on a `--bg` ground, `roundRect` rather than the circle it used to draw) instead
  of a pip added to an unchanged tile: `--warning` is already the product's "waiting on you"
  hue, so at 16px in an unfocused tab the states have to differ in value, not in contents.
  The mark also took over the board head's 30 × 30 back control — brand and home in one
  control, same `aria-label`, still hidden under `body.readonly` — and now leads the index
  title. The hue is shared with `.live-dot` and `.pending-badge.has-pending` from here on;
  `ADR.md` entry 12 records what that costs.

- **The prose-vs-shim checker is no longer something every caller pastes a bootstrap for.**
  Its subject moved into this repo with the manual, so `PROTOCOL.md`'s copy-paste resolution
  story is documented as the last resort rather than the shape every caller takes: a caller
  restating no protocol needs no check, and a caller making one vocabulary claim can assert it
  against the installed manual with a plain file read. The three renderer skills dropped the
  18-line launchd-plist loader entirely; `/example` keeps its one assertion (it posts
  `choose-between-rendered-variants`) and now checks it that cheaper way.

- **A markdown link opens in a new tab.** Every rendered link now carries
  `target="_blank" rel="noopener noreferrer"`. A board is a thing the reviewer is in the
  middle of, and a same-tab navigation discarded unsubmitted answers and half-typed comments
  with no warning and no way back to the draft. Neutralised URLs still collapse to `href="#"`
  exactly as before.

- **The pomodoro's `sound` toggle is three per-phase cues now.** `cueWork`, `cueBreak` and
  `cueLongBreak` each hold a bare name out of `/System/Library/Sounds`, or `"None"`, so
  crossing into a work interval, a short break and a long break can each sound different —
  the reader picks by ear, in the settings popover, rather than reading a boolean that only
  ever meant "on". A fresh install (no `pomodoro.json` at all) starts with three different
  cues out of the box, one per phase, each falling back to `None` on a machine missing the
  preferred sound. Picking a cue plays it immediately, over a new `POST
  /api/pomodoro/preview` route that reads and writes nothing (not `pomodoro.json`, not
  `settings.notify`) and plays the file directly with `afplay` rather than through
  Notification Center, so auditioning a cue never raises a banner; a fast run of picker
  changes kills whatever preview is still playing before starting the next, never layering
  into a chorus. `sound` itself is retired and migrates on the next read of an existing
  `pomodoro.json`: `sound: true` becomes `Glass` on all three cues, `sound: false` becomes
  `None` on all three, and no document is left holding a `sound` key that still does
  anything.

  Outside the preview, the cue rides the boundary notification's own sound rather than
  being played beside it — the reason being that every control macOS already gives you over
  claude-board's notifications (the per-app sound toggle, turning notifications off, a
  Focus) then silences the cue too, with no second mute switch to find in this app's own
  settings.

  That shape survived a real reversal, worth recording because it changes what the feature
  cost. The plan going in (`ADR.md` entry 20, superseding entry 18) was to stage the 14
  files at `/System/Library/Sounds` into the app bundle's own `Contents/Resources` at
  install time — about 4.7 MB and a new install step, on the strength of Apple's documented
  claim that `UNNotificationSound soundNamed:` resolves a bare name against a bundle's own
  Resources and `Library/Sounds`, and explicitly not against the system directory. The spec
  required measuring that claim before writing the staging step, and the measurement
  ([QUIRKS.md](QUIRKS.md), "`soundNamed:` searches `/System/Library/Sounds` and does NOT
  search the app bundle") found it backwards in both halves: a bare name already resolves
  against `/System/Library/Sounds` with nothing staged at all, and a file planted in the
  bundle under the exact requested name still loses to the system copy — the decisive run
  logged `systemsoundserverd` reading 475278 bytes from `/System/Library/Sounds/Glass.aiff`
  even with a 221376-byte decoy filed under that same name sitting in the bundle. The
  staging step would not have worked, so the feature that shipped instead costs nothing
  beyond it: no install step, no bytes added to the bundle, no re-sign, no TCC
  re-approval, no change to `install.sh` at all. `src/cues.mjs` reads
  `/System/Library/Sounds` live rather than shipping a fixed list of 14, so the picker
  offers whatever sounds are actually on the machine.

### Fixed

- **Pomodoro settings no longer snap back while you are filling them in.** Type a duration,
  move to the next field, and the first one reverted within a second. The widget repaints its
  countdown every second, and every repaint rewrote every settings field except the one holding
  focus — from the daemon's values, which still held the old number because nothing had been
  saved yet. Leaving a field is not abandoning the edit; only Save is. The panel now syncs from
  the daemon only while it is closed, so an open panel is never written to from underneath, and
  it still shows current values the moment it opens.

- **The pomodoro pause control worked again, having never actually been hidden.** It set
  `hidden` to disappear when no timer was running, but `[hidden] { display: none }` is a UA
  rule and its own class set `display: inline-flex`, which outranks it — so it rendered as an
  empty pill that did nothing, there being no timer for it to pause. The switch that replaced
  it is never hidden and never relies on `hidden`. See QUIRKS.md.

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
- **A rogue `launcher_paths.h` next to `bin/launcher.c` can no longer reach the build.**
  `bin/launcher.c` pulls in its generated header with a *quoted* `#include`, and a quoted
  include searches the including file's own directory before any `-I`/`-iquote` path —
  so compiling the source in place, straight out of the clone, let a header dropped into
  `bin/` shadow the real one `install.sh` generates and get compiled and ad-hoc signed,
  unnoticed, into a bundle macOS then trusts with the Documents grant. Deleting the shadow
  afterwards left the clone byte-identical to upstream either way. `install.sh` now copies
  `bin/launcher.c` into the same `mktemp -d` directory it already generates the header
  into, and compiles that copy with `-iquote` in place of `-I`: no include path reaches
  back into the clone, so the shadow has no route into the build regardless of whether
  anyone notices it — a structural fix rather than a check that could rot. A leftover
  `bin/launcher_paths.h` still found in the clone (plausible: an older `install.sh`
  generated it in place) earns one non-fatal warning naming the file, not a failed
  install. See ADR.md entry 14.
- **The rebuild stamp now covers the installed executable's own bytes, not just its
  inputs.** `~/.config/claude-board/launcher.stamp` hashed the launcher source, the
  generated header, the generated `Info.plist` and the bundle identifier — everything
  that *decides* the bundle's bytes — but nothing about what actually landed at
  `~/Applications/claude-board.app/Contents/MacOS/claude-board`. A direct edit of that
  installed executable bypassed every one of those inputs and left the "already current"
  check none the wiser. The stamp file now carries a second field, the sha256 of the
  executable as installed (hashed after the atomic `mv`), and a reinstall is "already
  current" only when that hash still matches too, on top of the existing input-stamp,
  executable-exists and `codesign --verify` conditions. A stamp file from before this
  change has only the first field; the missing second never matches a real digest, so
  the very next install rebuilds once — and writes a fresh two-field stamp — rather than
  crashing on it. Tested empirically against the exact `codesign --verify` invocation
  `install.sh` already runs: ad-hoc signing already refuses a bundle whose main
  executable has been altered by even one flipped byte, so the new hash is redundant
  with that check today — cheap belt-and-braces, not the only thing standing between a
  tampered binary and a false "already current". See ADR.md entry 14.

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
