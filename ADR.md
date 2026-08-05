# Architecture Decision Record

## 1. Theme selection is client-side only — 2026-07-30

**Context:** The board needed a light theme with a remembered manual override. The
natural implementation is a cookie the server reads, rendering the theme class into
the HTML — flash-free, and one preference regardless of which loopback host or port
the reader arrives on. But the served page and the standalone `pages/*.html` archive
are asserted byte-identical, and the page's bytes are documented as a pure function
of the board JSON. A server that varies its output by request state breaks both.

**Decision:** The theme is chosen entirely in the browser: a media query supplies the
default, and an override lives in `localStorage`, applied by an inline script that
runs before first paint. The server learns nothing about the reader's preference.

**Consequences:** The byte-identity invariant survives untouched, and no new
server-side state or endpoint exists. In exchange the preference is scoped to
scheme+host+port, so it does not follow the reader across `127.0.0.1`, `localhost`
and `*.localhost`, and changing `CLAUDE_BOARD_PORT` orphans it. Standalone archives
follow the OS and forget any override when closed, but not because `file://` blocks
storage — it doesn't, in Chrome or Firefox. `src/theme.mjs` explicitly gates every
storage access on `location.protocol !== 'file:'`, a product decision: every `file://`
document on the machine shares one storage partition, so an ungated archive would
read and write a preference belonging to every other archive ever opened from disk,
not only its own. Host canonicalization would collapse the origin split but was
ruled out as too large a change to security-reviewed Host handling for a cosmetic
preference.

_Amended 2026-07-31 after the audit._ This entry originally read: "Standalone
archives open at a `file://` opaque origin and therefore cannot read or write it at
all." Measured wrong: `file://` pages have working `localStorage`. The gate above,
not the platform, is what actually stops the archive — treating it as redundant and
removing it would make an archive persist a preference again, breaking acceptance
criterion 9.

## 2. Comments are deletable only before Send — 2026-07-30

**Context:** A comment queued in comment mode could not be removed at all, and clicking
the same element twice silently queued a second comment on the same anchor. Fixing the
gesture raised how far "delete" reaches. Server-side, `board.comments` is append-only and
a comment's `n` is `board.comments.length + 1` (`src/board.mjs`), which is simultaneously
its pin number, its identifier in the packet handed to the agent, and its position in the
archive.

**Decision:** Deletion and editing apply only to comments still queued in the page's
`pendingComments` array. A second click on an element with an unsent comment reopens it
prefilled; a second click on an element with a *sent* comment does nothing and is
de-affordanced in comment mode. Nothing removes or renumbers a comment after Send.

_Amended 2026-08-01 after the audit._ The reopen-prefilled half excludes elements inside
an `html` stage. The anchor on that path is a string the stage chose rather than something
the page observed, so looking up a queued comment by it would let agent-authored markup
pick **which** of the reviewer's queued comments the next submit replaces — the stage can
already mint a comment, but it must never be able to select an existing one to overwrite.
A repeat click on a stage element therefore queues a second comment, removable with the
delete control. Every other path — plain DOM, markdown anchors, mermaid nodes — keeps the
full edit behaviour. Recorded in DESIGN.md ("Criterion 1 excludes html-stage elements",
product call, approved) and pinned by `test/check-stage-isolation.mjs`.

**Consequences:** No delete endpoint, no protocol change, no renumbering of anything the
agent has already read, and the archive stays a faithful record of the exchange — which
is what criteria 4 and 14 rest on. In exchange, a typo noticed one second after Send is
permanent, and the reviewer's only recourse is a second comment correcting the first.
Rejected: click-to-toggle-delete, destructive on a single click with no confirmation;
rejected: deleting within a still-open round, which produces no packet yet but does
require an endpoint and a decision about gaps in the `n` sequence.

## 3. References resolve inside a configured allowlist, not only `cwd` — 2026-07-30

**Context:** `src/resolve.mjs` confined every reference to the board's own `cwd`. That is
half of a real boundary — the other half being that a caller choosing `cwd: '/'` reaches
everything anyway — but it also means a session can never render the skill, command or
agent file it is discussing. Grilling this repo hit the refusal twice in one session,
since the subject matter *is* `~/.claude` content.

**Decision:** References resolve if they sit under `cwd` **or** under one of a configured
set of roots, supplied as `CLAUDE_BOARD_REF_ROOTS` (colon-separated absolute paths),
defaulting to ~~`~/.claude`~~ **`~/.claude/skills`, `~/.claude/commands` and
`~/.claude/agents`** (amended 2026-07-31; see below). Each root is validated exactly as
`resolveBoardCwd` already validates `cwd`: realpath'd, must be an existing directory,
refused if it is `/` or `$HOME` or above.

**Amendment, 2026-07-31 — the default narrows to three directories.** The justification
in this entry's own Context is "render the skill, command or agent file it is
discussing", and that is exactly `~/.claude/skills`, `~/.claude/commands` and
`~/.claude/agents`. The rest of that tree is `settings.json`, `.credentials.json`, shell
snapshots, project transcripts and every plugin's private state, none of which the case
above ever asked for — the old default granted them by writing down a parent directory
rather than the three the argument named. Two mechanical consequences follow, both
recorded here because they are the part a reader would otherwise have to reconstruct:

- **An absent `CLAUDE_BOARD_REF_ROOTS` now means an empty allowlist**, not the default.
  Every install predating this entry has a plist with no such key, and the daemon
  restarts itself whenever `src/` changes, so a default living in code would have gone
  live on those machines during an ordinary `git pull` — the boundary widening itself
  with nothing printed and nobody asked. The default lives in `install.sh` instead, which
  makes running the installer the consent event.
- **`install.sh` carries an installed plist's value forward** when the variable is unset,
  rather than rewriting it from the default. Otherwise an operator who narrowed the
  boundary deliberately had that decision reverted by their next upgrade.

`CLAUDE_BOARD_REF_ROOTS=$HOME/.claude` still does exactly what it says, for anyone who
wants the whole tree.

**Consequences:** Widens what a confused or hostile agent can pull into a board, and
boards embed the content they resolve — so this enlarges the corpus reachable by anyone
holding the session cookie. `SECURITY.md`'s statement of the reference boundary has to be
rewritten rather than amended. The daemon runs under launchd, so the variable must reach
it through the plist and therefore through `install.sh`; a misconfigured root silently
widens the gate, which is the cost of making it configurable at all. Rejected: hardcoding
`~/.claude` (smallest widening, but every other tool's config is then unreachable);
rejected: dropping confinement entirely, which is more honest about the weak boundary but
rewrites the security posture for a convenience fix.

One consequence this entry did not anticipate, found by audit on 2026-07-31 and worth
recording where the decision is: making the allowlist *always populated and always
agent-writable* changed the value of defects the `cwd`-only boundary also had. The gap
between checking a path and re-opening it was raceable before, but only by something that
could already write inside the project; with roots that are always present it became a
general escape, and was closed by resolving each reference to a descriptor once and
reading from that. A hard link into a root is the same shape and is not closed — see
`SECURITY.md`, "Not defended, by design".

## 4. Every command falls back off the board, `/grill` included — 2026-07-31

**Context:** `SPEC_LAUNCH.md` and `commands/grill.md` both state the opposite, deliberately
and at length: there is no automatic fallback to the terminal for a board-shaped round,
because "a feature that quietly downgrades is a feature that stays broken for a week." The
shim enforces it by refusing a non-interactive session before posting anything. Migrating
`/audit`, `/example` and the renderers onto the board made that rule load-bearing for
commands that do have a terminal path — and the reviewer wants these runnable headless, on a
VPS, where the shim refuses by design.

**Decision:** Every command carries a non-board path and takes it on three triggers,
announcing that it did: the board is unreachable, the session is headless, or **the daemon
cannot open a tab**. The third was added in round 7 and is the VPS case the reviewer actually
meant — SSH gives `CLAUDE_CODE_ENTRYPOINT=cli`, so the interactive check passes and the daemon
is reachable, but `openBoardTab` returns silently off darwin without `CLAUDE_BOARD_OPEN_CMD`
(`bin/mcp.mjs:328`); the board posts where nobody can see it and `ask` blocks for the full two
hours. The shim refuses that case up front so it surfaces as an `isError` like the other two.
`CLAUDE_BOARD_HEADLESS=1` — which already exists (`bin/mcp.mjs:94`) — is documented as the
manual opt-out for a machine that *could* open a tab. A fallback is **degraded, not
equivalent**: it promises a path exists, never the same experience. `/grill` falls back to
`AskUserQuestion` and loses multi-select, ranking, attached context and comment anchoring.
`/example` writes its HTML and says the visual choice was unavailable. `/audit` writes the
findings file it writes today.

**Consequences:** The rule the launch spec picked to protect is gone, and the failure it
predicted is now possible: a broken board can go unnoticed for as long as the degraded path
keeps working, which is exactly how the EPERM defect survived seven rounds. What replaces it
is announcement rather than refusal, which is weaker and depends on a human reading the line.
`commands/grill.md`'s "Fail loudly, don't fall back" section and the
`no automatic terminal fallback is described` case in `test/check-grill.mjs` both have to be
rewritten, so this reaches published docs and a check, not just a prompt. It stops there,
though: `bin/mcp.mjs` keeps returning `isError` on an unreachable daemon and that assertion
stays, so only the command's *response* to the error changes. "Loud" survives;
"unrecoverable" is what was actually traded away. Accepted because the alternative is that a headless
runner cannot use any migrated command at all, and because the board is additive for every
command but `/grill` — for `/grill` alone, the fallback genuinely loses the artifact.
Rejected: migrated commands fall back and `/grill` does not (two rules, and the VPS case
still fails for the one command most likely to be run there); rejected: nothing falls back,
which leaves "the daemon is merely down on your own machine" unanswered.

**Status: accepted.** Both rewrites this entry named as the condition for accepting it have
now landed, in the same change (ticket 07 / `SPEC_MIGRATION.md`). `commands/grill.md`'s fail
section, renamed "Fail loudly, then take the degraded path", now names all three triggers,
relays the `isError` message verbatim including which one fired, and continues through
`AskUserQuestion` for the rest of the session, stating plainly what that costs: multi-select,
ranking, attached context and comment anchoring. `test/check-grill.mjs`'s case, renamed from
`no automatic terminal fallback is described` to assert that a fallback IS described, now binds
that shape: it fails against the pre-rewrite prose this entry was written against (missing the
`headless` and `cannot open a tab` trigger names, and still carrying the disavowed `no automatic
fallback` sentence) and passes against the rewrite. Only the command's response to the error
changed: `bin/mcp.mjs` still returns `isError` on all three triggers, untouched.

## 5. This repo ships the protocol, not its callers — 2026-07-31

**Context:** `install.sh` has always installed three things: the LaunchAgent, the local secret,
and `commands/grill.md` copied to `~/.claude/commands/`. That third step made sense while
`/grill` was the board's only caller and this repo had written it. `SPEC_MIGRATION.md` then
grew four skills and a second command as callers, none of which this repo wrote, and asked
whether they should move in. Round 9 said no for the skills. Round 10 said no for `/wayfind`,
then went further than the question asked: *"Move grill out of repo, let's keep all the skills
and commands out of repo I know this is a big change."*

**Decision:** `claude-board` ships the daemon, the shim, the protocol and the shared prose
checker. It ships **no callers**. `commands/grill.md` is deleted from the repo and lives only
at `~/.claude/commands/grill.md`; `install.sh` drops its third install step and no longer
requires that file to exist. Skills and commands are personal, versioned in `~/.claude`'s own
git repo, and evolve on their own schedule.

**Consequences:** The repo gets a clean boundary — one artifact, one job — and callers stop
being coupled to this project's release cycle. What it costs is the thing that made the
boundary safe: `test/check-grill.mjs` is the only check in this repo that binds prose to
mechanism, and its subject leaves. After the move, **nothing in this repo's suite proves any
prose matches the shim**; the repo ships a library and trusts callers to run it. That inverts
the dependency too — personal skills now import a path inside this repo and stop working
standalone if it moves. `SPEC_MIGRATION.md` criterion 12 owns that seam and round 10 left it
`deferred`, so the shape is chosen but not settled.
Rejected: callers move IN (checkable in CI, but this repo starts shipping ~110KB of templates
it did not author, and your skills couple to its releases); rejected: the status quo, one
caller in and five out, which is a rule with no principle behind it.

**Status: accepted.** The move, the `install.sh` edit and criterion 12 have all landed
(ticket 04 / `SPEC_MIGRATION.md`). `commands/grill.md` is deleted from this repo (`git rm`,
not left behind for a stale copy to drift from) and lives only at
`~/.claude/commands/grill.md`. `install.sh` no longer references `GRILL_SRC`,
`COMMAND_FILE` or the hash file and comparison branch that decided whether to overwrite a
user's edited copy — the whole step is gone, not merely skipped, and the preflight error
no longer requires `commands/grill.md` to exist. `uninstall.sh` follows: it no longer
deletes (or claims to delete) a command file, because doing so now would mean destroying a
file this repo did not install and does not own.

Criterion 12 was already answered, before this ticket: ticket 03 shipped
`src/prose-check.mjs`, proved against a fixture it owns. So the boundary this entry drew —
"nothing in this repo's suite proves any prose matches the shim" — never actually opened;
the generic mechanism existed before `test/check-grill.mjs`'s subject left. What DID
disappear with that file was checked one assertion at a time rather than assumed: every
grill-prose-specific assertion (no HTML template, the one-question rule being gone, the
context-reference field name, install.sh shipping *this* file) had nowhere left to bind and
was retired with it. The one assertion in that file that was never about grill's prose —
`bin/mcp.mjs` returns `isError` on an unreachable daemon — was already independently
asserted in `test/check-mcp.mjs` ("an unreachable daemon reports the revive command and
writes nothing"), so it lost no coverage: flipping that `isError` to `false` still fails
that check today. `test/check-install.mjs`'s grill-install-step tests (fresh install writes
the shipped file, an unmodified copy updates, an edited copy survives, uninstall mirrors
all three) are retired the same way, replaced by assertions that the removed machinery
(`GRILL_SRC`, `COMMAND_FILE`, the hash record) is actually gone from both scripts' source,
and that a file sitting at the old command-file path survives an uninstall untouched.

**Amended by entry 11, 2026-08-04.** "It ships **no callers**" stands; "it ships no files under
`~/.claude`" does not. `install.sh` installs one — `skills/claude-board/SKILL.md`, the manual for
the `ask` tool — on the argument that a manual is the protocol in the form an agent reads, and
that this repo wrote the protocol. The hash-comparison machinery this entry deleted stays
deleted: the copy is unconditional.

## 6. Commenting is confined to content blocks — 2026-08-01

**Context:** All six block kinds carried a comment button in their kicker and, independently
of it, responded to comment mode's click-to-anchor gesture. Two of them render no content of
their own: `question` is a card around a widget, `compare` is a grid around two nested blocks.
A comment anchored to either names no item the agent can act on, and on a question it says
strictly less than the `note` field on the same card already says. `DESIGN.md` "Anchoring
criteria" 1 had closed on the opposite promise — "in every kind of content the board renders
… one side of a comparison, and a question's own widget" — verified in real Chrome on
2026-07-30, so narrowing it is a reversal, not a gap being filled.

**Decision:** The split is wrapper versus content, not a list of kinds. `markdown`, `mermaid`,
`html` and `code` keep the button and the gesture. `question` and `compare` lose both. Nested
blocks are untouched: a question's `context` entry and a compare side render through the same
`renderBlock` dispatch with their own ids and their own comment areas, and keep them, so the
material actually worth commenting on stays reachable one level in. The whole-block button
survives on the four content kinds rather than being narrowed to element-level anchors only.
Criteria 1 and 7 are amended to match; boards already on disk are dropped rather than
supported.

**Consequences:** One rule covers both wrappers with no exception to remember, and a board of
pure questions carries no comment affordance at all. The costs are real and accepted: a
comparison can no longer be commented on as a whole (only one side or the other), a compare
side's label and a side with no content block become unanchorable, and comments already stored
against question or compare blocks in archived boards are not a supported case. The button
staying on the four content kinds is what keeps a block that failed to render — an unresolved
reference, a diagram the CDN never drew, a blank stage — from becoming silently uncommentable;
element-level-only was rejected for exactly that. Also rejected: removing the button while
leaving the gesture live, which narrows nothing because comment mode mints anchors on its own;
and the middle position on `compare` (button gone, side-level clicks kept), rejected as the one
option inconsistent with every other wrapper.

## 7. An `html` block may name a file, but only a whole one — 2026-08-04

**Context:** `html` was the one content kind with no `source` ref, on the reasoning that a
hand-mocked stage has no file to point at. That held until agents started producing real
rendered pages on disk, at which point the only way onto a board was to emit the whole file as
generated tokens — ~25-30K of them for an 80 KB document, a price an agent silently declined to
pay on 2026-08-04, posting a stub and misreporting a size limit as the cause. The grill that
followed disproved its own premise twice: no limit had fired (the file was a tenth of the cap),
and the fix first proposed would not have closed the problem first named, because `resolveRef`
checks the whole file's size from `fstat` before slicing, so a reference has never raised the
cap for any kind.

**Decision:** `html` accepts `source: { path }`, resolved through the same reader, confinement,
cap and block-level error behaviour as every other kind. Path only — `lines` and `section` are
refused with an error naming markup slicing as the reason. Rejected: a separate `document`
kind, which would have kept `html` meaning one thing at the cost of a second kind to render,
document and anchor; and making the cap slice-aware, which would have closed the original
(imagined) problem but moves the check that bounds a read before the bytes reach the daemon's
heap. The security restatement was put to the user and declined as out of interest for a
local-only tool, so a referenced file executes in the stage on exactly the footing an inline
mock already did, with `SECURITY.md` recording that rather than defending against it.

**Consequences:** The protocol's "html is the exception that has no source" sentence is now
false wherever it appears and must be rewritten rather than amended. `html` is the only kind
whose ref is path-only, which is an exception a reader will trip over and which exists because
text survives a knife and markup does not. Nothing here helps a file over the cap, in either
direction — that remains a hard refusal, and the misleading "use a source reference instead"
message that implied otherwise is corrected as part of the same work. Inlining a full rendered
document onto a board stays a bad idea for unrelated reasons (the 320px stage floor, the
CSP-blocked local mermaid asset), so `/explain` posts a pointer instead; that edit lives in
`~/.claude/skills/explain/`, outside this repo.

## 8. The daemon owns the pomodoro clock, unlike every other preference — 2026-08-04

**Context:** ADR 1 settled that theme is client-side only, and that precedent has held for every
setting since: this project has no server-side user state at all, only boards. The pomodoro timer
(`SPEC_POMODORO.md`) asked the same question and got the opposite answer.

**Decision:** the daemon holds the timer — the current interval's **absolute wall deadline**, the
long-break cycle counter, and the durations/toggles — persisted under `CLAUDE_BOARD_HOME` beside
the board store. The browser renders a countdown from that deadline; it never owns one.

**Consequences:** the countdown survives closing every tab, and two open tabs cannot disagree,
which is the whole point — a pomodoro you lose by closing a tab is not a pomodoro. Storing the
deadline rather than remaining seconds is what makes a daemon restart transparent, and it is also
what makes the sleep rule expressible: a deadline already in the past is discarded silently rather
than fired, so reopening a lid after four hours does not stack up reminders for breaks you took by
being asleep. The costs are real. The daemon becomes stateful about something that is not a board,
which every earlier decision avoided; `uninstall.sh` grows a second thing to clean up; and ADR 1's
principle now needs a stated boundary rather than being read as universal. That boundary is: a
**theme is a per-reader preference** and belongs to the reader's browser, while a **pomodoro is a
single fact about the human** and cannot be per-tab without being meaningless.
Rejected: localStorage, mirroring ADR 1 exactly and costing zero server changes, which loses the
timer whenever you close the tab and runs two disagreeing countdowns when you open two.

## 9. No menu bar item — the app bundle's signature is load-bearing — 2026-08-04

**Context:** `claude-board` is always on under launchd and already ships a macOS app bundle, so a
menu bar countdown looks like it should be nearly free — and `SPEC_POMODORO.md` was drafted twice,
once with it out of scope and once with it in, before the cost was actually priced.

**Decision:** no menu bar item, no `NSStatusItem`, and no AppKit in `bin/launcher.c`. The pomodoro
surfaces are a native notification at each boundary and a widget on the index page.

**Consequences:** the always-visible glance the menu bar would have given is the thing given up,
and it is the surface a pomodoro most wants. What buys it back is that `~/Applications/claude-board.app`
is **ad-hoc signed**, and `install.sh` already refuses to put a `CFBundleVersion` in it for this
exact reason: changing the bundle's bytes changes its signature and costs the user their TCC
Documents grant. This repo lives in `~/Documents`, so that grant is not incidental — losing it
turns every reference into that tree into an EPERM on a board. A menu bar in the existing launcher
therefore costs a re-approval in System Settings on every install, and it also means flipping
`LSBackgroundOnly` (which forbids a status item outright) to `LSUIElement`, and growing an
`NSApplication` run loop inside 150 lines of C whose fork-not-exec structure is the entire
mechanism by which the TCC grant reaches the daemon at all. A notification posted by `osascript`
attributes to "Script Editor" in Notification Center rather than to claude-board; that ugliness is
the accepted price of not touching the bundle.
Rejected: a second, separate bundle for the menu bar, which leaves `launcher.c` and its signature
alone but needs its own compile, ad-hoc signature, launchd agent and uninstall path — a lot of new
installer surface for a countdown. If the menu bar is ever revisited, that is the shape to revisit,
not AppKit in the launcher.

**Amended by entry 19, 2026-08-05.** The menu bar decision stands. The sentence about the
notification does not: "a notification posted by `osascript` attributes to Script Editor; that
ugliness is the accepted price of not touching the bundle" was priced against a launcher whose
bytes only moved when `launcher.c` did. Entry 15 has since folded `bin/daemon.mjs` and all of
`src/` into the same signature, so **every** install that lands a code change already rebuilds,
re-signs and costs the reader that TCC prompt. "Not touching the bundle" stopped being a thing an
install could buy, and with it the reason to accept Script Editor's icon on the reader's screen.
Entry 19 posts the notification from this bundle instead. Note what did NOT change: this entry's
underlying rule, that a *gratuitous* rebuild — a run that changed nothing — must never happen, is
exactly as load-bearing as it was, and is what `install.sh`'s rebuild stamp still enforces.

## 10. The daemon serves a rendered file, it does not render one — 2026-08-04

**Context:** Entry 7 left `/explain` posting a pointer: an absolute path as plain text. A path
is not clickable, and the two obvious ways to make it so are both dead. Markdown deliberately
allows only `http(s)` and `mailto`, so a `file://` link renders as `href="#"`; and even if it
did not, no browser will navigate from an `http://127.0.0.1` page to `file://`. The daemon also
could not read `~/Documents/renders` at all — not under any board's `cwd`, not in
`DEFAULT_REF_ROOTS`.

**Decision:** A `GET /file/<path>` route that streams a file from `CLAUDE_BOARD_SERVE_ROOTS`
byte for byte, and markdown links that open in a new tab. The board does no processing: it
does not wrap the document in a block, slice it, cap it, or generate a listing for a directory
(a directory answers with the `index.html` a generator already wrote there). Rejected: having
the daemon `spawn` an opener on the path, which is ~15 lines against this route's ~80 but adds
an exec surface reachable by anything that can reach the daemon; and a copy-to-clipboard
affordance, which is not a link. Serving gets its OWN allowlist rather than reusing the
reference roots, because a referenced file is escaped into a block while a served one is a live
document at the daemon's origin — sharing one list would have widened every existing install's
boundary on a `git pull`, the exact failure entry 3 was written to prevent.

**Consequences:** A served document is same-origin with `/api/board`, and the session cookie is
`SameSite=Strict`, so a `fetch` from one would carry it — the served response's CSP therefore
sets `connect-src 'none'` and `form-action 'none'`, which is the clause the route's safety
rests on rather than a hardening flourish. What it does not stop is a top-level navigation from
a served page to a daemon URL; those are GETs against read routes, landing in a visible tab,
and `navigate-to` does not exist in any shipping browser. Every refusal collapses to a bare 404
so the route cannot be used to probe the disk, which means a genuine misconfiguration (a root
that was dropped for not existing) looks exactly like a typo — the install script prints the
resolved roots for that reason. `~/Documents/renders` as the shipped default is a convention
this repo does not own and cannot enforce; a machine without that directory installs fine and
serves nothing.

## 11. The repo ships one caller-facing file: the manual — 2026-08-04

**Context:** Entry 5 drew the boundary at "the protocol, not its callers", and it held for the
callers. It did not hold for the protocol. Six files outside this repo — `commands/grill.md`,
`commands/wayfind.md` and the `example`, `explain`, `gamify` and `visualize` skills — each
carried their own statement of how to call `ask`: 148 lines between them, three of them
word-for-word identical on the `posted`/`isError` paragraph. That duplication then grew its own
infrastructure: `src/prose-check.mjs` exists to catch drift in those copies, and four of the six
pasted the same 18-line launchd-plist bootstrap into a `check.mjs` to reach it, a copy-paste this
repo documented as a maintenance contract (PROTOCOL.md, "Resolution story"). Six copies, six
chances to drift, and they had: five of the six never told the agent to relay the recovery
command the tool prints, `grill.md` documented four widgets for as long as there were five, and
its "html has no source" sentence went stale the day entry 7 landed.

**Decision:** `skills/claude-board/SKILL.md` — the manual for the `ask` tool — ships from this
repo, and `install.sh` step 6 copies it to `~/.claude/skills/claude-board/`. Callers name the
skill and keep only what is theirs: which blocks they post, and what their own degraded path is.
A manual is not a caller. It teaches the call shape, the block kinds, the widgets, the packet and
the failure modes, and decides nothing about when to ask or what to ask about — it is the
protocol in the form an agent reads, which is the thing entry 5 already said this repo ships.

Copy, not symlink, and unconditional: no hash record, no did-they-edit-it branch. That machinery
is what entry 5 deleted along with the old command-file step, and it is not coming back — the
file is this repo's, says so in its own first line, and the failure this step exists to prevent
is a copy that quietly stops matching the shim. The copy is non-fatal: a daemon and a
registration are the install, and a missing manual must not fail a run that produced both.

**Consequences:** The boundary moves from "no files" to "one file, and it is ours" — a weaker
line than entry 5's, and one that needs defending every time something else asks to ship. The
test is authorship, not usefulness: this repo wrote the protocol, so it writes the manual; it did
not write `/grill`, so `/grill` stays out. What that buys is the thing entry 5's own consequences
paragraph called the cost of the move: `test/check-skill-prose.mjs` binds prose to mechanism
again, in the same repo as the shim, on the commit that breaks it. It goes further than
`test/check-grill.mjs` ever did — it also checks for *absence*, failing when a widget, block kind
or packet status PROTOCOL.md defines is missing from the manual, which is the check that would
have caught the four-widget drift. The plist bootstrap loses its last real caller; `/example`
keeps one assertion of its own (it posts `choose-between-rendered-variants`) and now proves it
against the installed manual, reading a file rather than resolving a repo.
Rejected: a symlink, which keeps one source of truth and updates with `git pull` — the reviewer
chose the copy, and the drift it risks is now bounded by the check above. Rejected: folding the
protocol into the `ask` tool's own description, which needs no install step at all but puts the
whole protocol in the context window of every session, board or no board. Rejected: leaving the
manual in `~/.claude`, which deduplicates the callers but leaves this repo unable to prove its
own manual — the exact gap entry 5 opened and this entry closes.

**Status: accepted.** Shipped with the deduplication it exists for: the six callers now name the
skill instead of restating it, and the three `check.mjs` bootstraps went with the prose they
guarded. `install.sh` step 6 and `uninstall.sh` step 2b are covered by four checks in
`test/check-install.mjs` (byte-identical copy, an edited copy is overwritten, a clone with no
manual still installs, uninstall removes its own file and leaves a neighbour alone).

## 12. The mark is amber, so the brand shares a hue with "waiting on you" — 2026-08-04

**Context:** The tab mark was an `--accent` tile: periwinkle on dark, and a different blue on
light, because `--accent` is one of the tokens whose two theme values sit far apart in value. A
favicon gets no CSS and no `prefers-color-scheme` worth having — an icon that followed the
scheme vanishes into whichever tab strip it matched — so it read `DARK['--accent']` in both
themes, and on a light tab strip the tile was noticeably darker than anything else there. The
rows were 3.4 tall and merged into one bar after the browser's downsample to 16px, which is the
only size the mark is ever seen at. The redesign moved the tile to `DARK['--warning']`: amber is
the one hue this palette carries at nearly the same value in either theme's usable range, so one
tile serves both, and against near-black rows it is the highest value contrast the palette can
produce, which is what buys legibility at 16px.

**Decision:** The mark takes `--warning`, and the pending mark inverts the same tile — ink ground
where the mark is amber, an amber pip where the mark is ink — rather than adding anything to it.

Amber is not a free colour here. `--warning` is already how the product says *waiting on you*:
`.live-dot`, `.pending-badge.has-pending`, `.thread-item.live`, `.btn-defer.active`. An amber pip
on an amber tile would make idle and pending the same object at 16px, which is the whole job the
pending mark exists to do — the tab that needs marking is by definition the unfocused one, and in
peripheral vision a value flip is the only change that reliably lands. Inverting also puts the
pending mark on the same `rx 9` tile as the idle one, where it used to be a circle: idle and
pending are now one object in two states rather than two shapes at two corner radii.

The sibling decision — that the tab stops counting, so the mark carries no digit and the title
takes no `(n)` prefix (CHANGELOG, "The pending-round mark on a tab lost its number, not its
mark") — landed independently and is untouched here. The two compose: with no digit to carry,
the whole signal is the value flip, which is exactly what the inversion is for. The design this
came from had specified a numeral on the inverted tile; the count was dropped between the two,
and the inversion was kept because its argument was never the digit.

**Consequences:** The brand now permanently shares a hue with a state colour, and the sharing
runs one way only. A future palette edit to `--warning` — retuning the live dot, say — moves the
tile and the mark with it, silently, because both read the token rather than a literal. That is
the cost, and it is accepted in exchange for the token discipline: no new hex enters the tree,
`test/check-pure.mjs`'s raw-literal check has nothing to catch, and a palette edit stays a
one-block edit. What must not be undone is the explicit `DARK` naming — light's `--warning` is
`#805300`, a brown tuned for contrast against text, and a well-meaning switch to the active
theme's token would turn the tile to mud on exactly half the machines.

## 13. The environment the daemon runs in is baked into the launcher, not read from the plist — 2026-08-04

**Context:** Entry 9 already treats the launcher bundle's signature as load-bearing and refuses
to touch it for a menu bar; this entry is the same trade applied to what the bundle actually
hands node. `~/Library/LaunchAgents/claude-board.plist` is mode 644 and user-writable — SECURITY.md
already named this before it was fixed — and until now `bin/launcher.c` `execv`'d, so node
inherited launchd's whole environment. A `NODE_OPTIONS=--require /some/script.js` key in the
plist's `EnvironmentVariables` dict ran arbitrary code inside the TCC-granted process with the
bundle's own signature untouched: no recompile, no re-sign, nothing to distinguish it from a
knob an operator meant to tune. `CLAUDE_BOARD_SECRET_FILE` and `CLAUDE_BOARD_REF_ROOTS` were
reachable the identical way, and `CLAUDE_BOARD_REF_ROOTS` was carried forward across every future
reinstall by reading the plist back — the same mechanism, pointed the other way, that would have
propagated an injected `NODE_OPTIONS` forever once it landed once.

**Decision:** `bin/launcher.c` now `execve`s with an environment it constructs itself, in two
tiers. `HOME`, `PATH`, `CLAUDE_BOARD_HOME`, `CLAUDE_BOARD_REF_ROOTS` and
`CLAUDE_BOARD_SERVE_ROOTS` — the five variables that decide what the daemon may read, serve and
write — are compiled in via `launcher_paths.h`, generated fresh by `install.sh` on every run,
exactly like `CLAUDE_BOARD_NODE` and `CLAUDE_BOARD_DAEMON` already were. `PATH` is fixed to
`/usr/bin:/bin:/usr/sbin:/sbin` rather than resolved from anywhere, since the daemon shells out
to `osascript` and `open` and an inherited `PATH` is itself a code-execution surface. A short
allowlist — `CLAUDE_BOARD_PORT`, `CLAUDE_BOARD_SHUTDOWN_MS`, `CLAUDE_BOARD_SSE_HEARTBEAT_MS`,
`CLAUDE_BOARD_TIMEOUT_MS`, `CLAUDE_BOARD_HANDOFF_TTL_MS`, `TMPDIR` — still passes through from
whatever the plist says, by exact name, no prefix match. The dividing line is not "security
knob vs. convenience knob", it is narrower and mechanical: does this variable change what
directory the grant can reach. None of the six can; all five compiled-in ones can. Everything
else — `NODE_OPTIONS` above all, and `CLAUDE_BOARD_SECRET_FILE`, deliberately on neither list
since a baked `HOME` already makes `~/.config/claude-board/secret` the only secret path the
process can reach — is simply absent from the child's environment: not stripped out of
something inherited, never placed there in the first place.

The corollary for `install.sh`: once a launcher bundle is in use, `CLAUDE_BOARD_REF_ROOTS`,
`CLAUDE_BOARD_SERVE_ROOTS` and `CLAUDE_BOARD_HOME` are no longer written into the plist at all.
Writing them and having the launcher ignore them would be worse than omitting them — a plist
that names a root the running daemon does not actually honour is a false statement about the
boundary, readable by exactly the process this fix is defending against. Carrying a customised
value forward across a reinstall therefore moves too: rather than reading it back out of the
plist (dead now that the plist does not carry it, and previously the exact channel that would
have made an injected `NODE_OPTIONS` durable across every future `git pull && ./install.sh`),
`install.sh` records the effective roots in the 0700 directory that already holds the secret and
the launcher's rebuild stamp, and reads them back from there. A plist written before this change
is still read once, as a migration, so an operator who narrowed `CLAUDE_BOARD_REF_ROOTS` before
today does not have that choice silently reset to the default by the same upgrade that closes
the hole.

**Consequences:** Retargeting any of the five baked variables now costs exactly what
retargeting `CLAUDE_BOARD_NODE` already cost — a rebuild, a re-sign, and the user's TCC grant
reset to be re-approved — which is a real, felt cost for an operator who wants to point
`CLAUDE_BOARD_REF_ROOTS` somewhere new, not a free `./install.sh` env var away any more the way
it read before this entry. That is accepted rather than worked around, because the alternative
is the hole this entry closes: anything that can widen a security boundary without a rebuild is
also reachable by anything that can write the plist, which is any process running as you,
including one TCC has already refused. The six passthrough names are the pressure valve —
timing and ports stay a plist edit away — and the list is meant to stay short: a future request
to add a seventh name should be read as a request to widen what the plist can move, not merely
to make an operator's life more convenient, and answered by the same test this entry's fix
applies — does it change what directory the grant reaches.

Rejected: keeping the roots in the plist and merely dropping `NODE_OPTIONS` and the other
obviously-dangerous names from a blocklist. A blocklist has to anticipate every future dangerous
variable; an allowlist only has to name the ones that are known to be safe, and everything
un-named — including whatever the next Node release invents — is refused by construction rather
than by having been thought of in time.

Two smaller consequences fell out. The tile now needs `roundRect` rather than `arc` (Safari
16.4+, Chrome 99+ — fine for a macOS-only tool, and where it is missing `drawFavicon`'s existing
`try/catch` returns null and the tab keeps its unbadged mark, which is the correct degradation).
And the mark took over the board head's 30 × 30 `.back-to-index` slot, which was already at
favicon proportions: brand and home are one control now instead of two side by side, it still
disappears under `body.readonly` where there is no daemon to go home to, and it keeps the arrow's
`aria-label`, so nothing changed for a screen reader. On the index — the one page with no back
control, and the one page whose `h1` is the product name — the mark leads the title instead.

**Status: accepted.** Covered by three checks in `test/check-pure.mjs`: the favicon paints
`DARK['--warning']` and never light's, the pending mark paints a `--warning` pip on a `--bg` tile
at the same `rx 9` (and never `--accent-ink`, which on `--bg` is a pip nobody can see — the state
this landed in straight out of the merge), and the marks in the board head and the index head are
the favicon's own rects rather than a second copy of the geometry.

## 14. The launcher is compiled from a staged copy, and the rebuild stamp covers the produced binary — 2026-08-04

**Context:** `bin/launcher.c` was compiled in place, straight out of the clone, with
`-I "$LAUNCHER_BUILD_DIR"` pointing the compiler at the header `install.sh` generates. The
source's own `#include "launcher_paths.h"` is a *quoted* include, and a quoted include searches
the including file's own directory before any `-I`/`-iquote` path — so a `launcher_paths.h`
dropped into `bin/`, next to the source, shadowed the real generated header and got compiled and
ad-hoc signed straight into a bundle macOS then trusts with the Documents grant (entry 9), with
nothing on screen saying so. Deleting the shadow afterwards leaves the clone byte-identical to
upstream, so the attack (or an innocent leftover — an older `install.sh` generated the header in
place) is invisible in `git status` either way.

Separately, and independently, the rebuild stamp at `~/.config/claude-board/launcher.stamp`
hashed every input that decides the bundle's bytes — the source, the generated header, the
generated `Info.plist`, the bundle identifier — and nothing about what actually landed at
`~/Applications/claude-board.app/Contents/MacOS/claude-board`. A hand-edit of the installed
executable, bypassing every one of those inputs, left the "already current" check none the wiser.

**Decision:** Two changes, one per gap, both confined to `install.sh`'s own staging and stamping —
neither touches `bin/launcher.c`'s content, the header's `#define`s, or the plist's
`EnvironmentVariables`, which stay another chunk's to own.

First, `install.sh` copies `bin/launcher.c` into the same `mktemp -d` directory it already
generates `launcher_paths.h` and the staged `Info.plist` into, and compiles that copy with
`-iquote "$LAUNCHER_BUILD_DIR"` in place of `-I`. With the source and its header both staged
together and no include path reaching the clone, a quoted include's own-directory search lands on
the real header no matter what sits beside `bin/launcher.c` — the fix is structural, not a check
that can rot, so a rogue header is powerless whether or not anyone notices it. On top of that,
`install.sh` still prints a single non-fatal warning naming the file if `bin/launcher_paths.h`
exists in the clone: refusing outright would turn a stale, innocent leftover into a failed
install, but silence would leave a genuinely planted one un-named.

Second, the stamp file gains a second field: the sha256 of the installed executable, computed
*after* the atomic `mv` — i.e., of the bytes at `$APP_EXEC`, not the staged copy. "Already
current" now requires that hash to match what is currently on disk, on top of the existing input
stamp, the executable-exists check, and `codesign --verify`. A stamp file written before this
change has only the first field; the missing second field can never equal a real digest, so that
case rebuilds once — earning a fresh, two-field stamp — rather than crashing on a short read.

**Consequences:** For the same inputs, nothing changes: a routine `git pull && ./install.sh`
still reports "already current" and the TCC grant survives, which is the whole point entry 9
exists to protect, and is worth restating because a stamp that is too eager to rebuild is exactly
as bad here as one that is not eager enough. The stamp file's format changes shape (two
newline-separated fields, not one bare hash); nothing outside `install.sh` reads its contents —
`uninstall.sh` only ever deletes it by path — so nothing else needed to change to match.

Tested empirically against the exact `codesign --verify "$APP_PATH"` invocation `install.sh`
already runs: ad-hoc code signing on macOS covers the main executable with page hashes in the
`CodeDirectory`, and `--verify` already refuses a bundle whose executable has been altered by even
one flipped byte, appended or interior. The executable hash added here is therefore redundant
with that check today — belt-and-braces, not the only thing standing between a tampered binary
and a false "already current" — but it is a few lines and one more `sha256_file` call, and it
stops being redundant the day a `codesign --verify` bypass or a signature-format quirk on some
future macOS makes the existing check less than airtight. Keeping both is cheaper than trusting
that day never comes.

**Status: accepted.** Covered by `test/check-install.mjs`: a rogue header planted next to
`bin/launcher.c` in a throwaway clone builds a bundle carrying the real, compiled-in paths and
none of the rogue ones, with a non-fatal warning on stdout; and a three-run sequence (build,
untouched reinstall reports "already current" and rewrites nothing, then the installed executable
is altered directly and the next run rebuilds — reproducing the original bytes exactly, since
nothing else changed) proves the stamp's new field does its job in both directions.

## 15. The daemon's own code is staged into the signed bundle, not left running from the clone — 2026-08-04

**Context:** Entries 13 and 14 made the launcher's environment and the launcher binary itself
trustworthy — compiled-in overrides, a stamp covering the produced executable — but both left
one thing untouched, and SECURITY.md said so plainly under "Known limits of that": `bin/daemon.mjs`
and everything under `src/` lived only in the clone. `ProgramArguments` named
`claude-board.app/Contents/MacOS/claude-board`, and that binary forked `node` against
`CLAUDE_BOARD_DAEMON`, a path compiled in by entry 13 — but a compiled-in path is only as
trustworthy as what sits at the far end of it, and what sat there was a plain file in a plain
git clone, writable by anything running as the user, unsigned, unstamped. The bundle's whole
premise — that holding the grant and being able to spend it are different things — held for the
launcher and fell apart one hop later: recompiling nothing, re-signing nothing, an edit to
`src/store.mjs` or `src/resolve.mjs` took effect on the very next request, under the identity the
user had granted Documents access to.

**Decision:** `install.sh`'s launcher-bundle step (already staging `bin/launcher.c`,
`launcher_paths.h` and `Info.plist` into a build directory ahead of `codesign`, per entry 14)
now stages the daemon's own payload there too: `bin/daemon.mjs` and the whole of `src/`, copied
into `$STAGED_APP/Contents/Resources` with their relative layout preserved, so
`bin/daemon.mjs`'s existing `import { startServer } from '../src/server.mjs'` resolves exactly
as it always did. The copy happens before the `codesign --force --sign -` call entry 9 already
runs, so the ad-hoc signature — and `codesign --verify`, already part of the "already current"
test — cover the payload on the identical footing as the launcher binary itself. A source copy,
not a bundled single file: this repo has no bundler and entry 5 already rejected inventing
machinery a zero-dependency tool does not need, a stack trace out of a copied `src/server.mjs`
still names the real file and line, and the tamper-obviousness a bundled file's own hash would
buy is already sitting there in the signature. `bin/mcp.mjs` and `bin/authorize.mjs` are
deliberately excluded: they are the shim, registered with Claude Code (`mcp.mjs`) or invoked
directly by a person (`authorize.mjs`) at the clone's own absolute path, never through the
launcher or under the TCC-granted identity — a copy inside the bundle would be a second file
nothing ever points at. `bin/launcher.c` is excluded for the same reason entry 14 already
established: it is a build input, never a thing executed as itself.

`CLAUDE_BOARD_DAEMON` (entry 13's compiled-in path) now names the INSTALLED bundle location —
`$APP_PATH/Contents/Resources/bin/daemon.mjs` — rather than the clone's, on the degraded
(no-launcher) path only continuing to name `$REPO_DIR/bin/daemon.mjs` directly, exactly as
before this entry: that path has no bundle to stage anything into, and stays the unsigned,
ungranted path it always was.

The rebuild stamp (entry 14's two-field file) gains a payload digest, folded into the existing
first field alongside the source, header, Info.plist and bundle-id hashes it already covered.
`payload_digest()` walks `bin/daemon.mjs` and every file under `src/`, hashes each individually,
and combines those hashes — paired with each file's own relative path — into one digest over a
SORTED file list: deterministic by construction, so two clean checkouts of identical content
produce the same digest regardless of mtime or the order a directory read happens to return
files in. This is the sharpest constraint the whole entry sits under — TCC pins a Documents
grant to the bundle's code signature, so a gratuitous rebuild on a run that changed nothing
would silently walk that grant back and lock the user out until they re-approve it, on every
routine `git pull && ./install.sh`, which is most installs. Folding a non-deterministic digest
into the stamp would have manufactured exactly that failure on a schedule no operator could
predict or reproduce.

One thing had to move for this to be safe rather than merely signed: `src/handoff.mjs`'s
`recoveryCommand()`, which names `bin/authorize.mjs` on the "not authorized" refusal page,
used to compute the clone's location from its own `import.meta.url` — correct when
`bin/daemon.mjs` ran straight out of the clone, wrong the instant it started running from a
copy inside the bundle, since it would have resolved to a directory inside
`Contents/Resources` and printed a command pointing at a file that is not there (`authorize.mjs`
is deliberately not staged, per the exclusion above). A sixth compiled-in override,
`CLAUDE_BOARD_REPO_ROOT` (`bin/launcher.c`'s `OVERRIDE_ENV`, `launcher_paths.h`'s
`CLAUDE_BOARD_REPO_ROOT_VALUE`), carries the real clone path instead, read by `repoRoot()`
in preference to the `import.meta.url` computation whenever it is set. It decides no
boundary the grant reaches — it is not a security override the way the other five are — but it
is baked in on the identical footing anyway: an env- or plist-supplied value here would be
exactly the kind of thing entry 13 exists to stop a rewritable plist from choosing, applied to
what a locked-out reviewer is told to run rather than to what the daemon may read.

**Consequences:** The clone is now unambiguously a build input rather than a live execution
path. A `git pull` with no `./install.sh` afterward changes nothing about what is running —
true in spirit since entry 13 stopped the daemon watching `src/` for changes, but now true in a
stronger sense: before this entry, a bare `launchctl kickstart` (no rebuild at all) was enough
to pick up an edited `bin/daemon.mjs`, because node re-read the clone's own file on every start.
After it, kickstart restarts the same already-built binary forking the same already-staged
copy, and only `./install.sh` — noticing the payload digest moved — rebuilds, re-signs and
lands a fresh copy (QUIRKS.md "A bare `kickstart` no longer picks up a source edit"). README.md
and INSTALL.md say this plainly where an operator meets it, not just here.

Rejected: leaving the payload out of the signature and relying on the stamp alone to force a
rebuild on any edit. A stamp with no matching signature coverage would still let anything
that can write BOTH the clone AND the stamp file — the same "any process running as you"
threat model this whole area already accepts as out of scope one layer up — edit the payload
and hand-edit the stamp to match, walking straight past the "already current" check with a
tampered bundle nothing would ever rebuild. Covering the payload with the signature closes that:
`codesign --verify`, already required for "already current," would refuse a bundle whose
`Resources/` no longer matches what it was signed over, the same way it already refuses a
tampered executable (entry 14).

**Status: accepted.** Covered by `test/check-install.mjs` (the payload lands byte-identical
inside this repo's own real bundle build, the rogue-header and XML-metacharacter throwaway
clones both now carry a `src/` stub and assert the BUNDLED daemon path is what gets compiled
in, and a no-op reinstall leaves the payload's own mtime untouched, not just its bytes) and by
the new `test/check-install-payload.mjs`, which builds a throwaway clone, edits its
`src/server.mjs`, runs the ALREADY-BUILT launcher and proves the old code is what answers,
reinstalls and proves that edit forces a rebuild, runs the REBUILT launcher and proves the new
code is what answers, drives an unauthenticated request against the running bundled daemon and
proves the refusal page names the clone's `bin/authorize.mjs` rather than a path inside the
bundle, and proves `payload_digest` itself is insensitive to mtime and directory-walk order
directly, against two hand-built trees, rather than only inferring it from two installs
happening to agree.

## 16. The index's search box filters sessions; it does not search inside them — 2026-08-04

**Context:** `GET /` used to run the same full-text walk as `GET /api/search` and render
block-level result cards (a question prompt, an option label, an answer note) in a section
below the thread list. Two differently-shaped answers to one query sat on the same page: a list
of sessions, and a list of fragments belonging to sessions. Deciding which one you were looking
at required reading both.

**Decision:** the box on the index is a filter over the thread list, matching on what
*identifies* a session — title, project folder, `cwd`, thread id — and nothing inside the
board. `filterThreads` (`src/indexpage.mjs`) does it from the fields `buildThreadIndex` already
extracted, so `GET /` no longer reads a board body to serve a query and no longer walks the
store a second time. `GET /api/search` is untouched and remains the full-text surface.

**Consequences:** you can no longer find a session from the index by something said inside it —
that answer moved entirely to `/api/search`, which no UI currently calls, so in practice
full-text is now an API-only capability. The thread id printed on every row stops being purely a
disambiguator and becomes the thing you type to isolate one of two identically-titled sessions.
Rules for `.search-results` / `.result-*` and the `resultRow` renderer are deleted rather than
left dormant, because `test/check-pure.mjs` fails any stylesheet class nothing emits; restoring
inline results later means writing that renderer again.

## 17. The pomodoro switch may start a timer, so the session cookie may call `ensure` — 2026-08-04

**Context:** `POMODORO_COOKIE_ACTIONS` (`src/server.mjs`) deliberately excluded `ensure`, on the
reasoning that its only caller was the session-start hook — a shell script holding the secret,
never a browser — so widening the cookie to reach it would buy nothing. That reasoning expired
the moment the index widget grew a way to start a pomodoro by hand: the caller is now a browser
holding only the session cookie.

**Decision:** `ensure` joins the set. The alternative considered and rejected was a
cookie-reachable alias for it (`/api/pomodoro/start`), which would have been the same reach
wearing a second route name plus a second code path to keep honest.

**Consequences:** any browser tab holding a session cookie can begin a work interval, which
means it can also trigger the notification that fires at the boundary. This is the smallest of
the five actions the cookie now carries: `startWork` is a no-op against any timer that already
exists, so the worst it does is start a clock that `reset` — already on the list — could have
ended anyway. The set stays a closed, named list rather than a `parts[1] === 'pomodoro'` prefix
match, so the next pomodoro write this file grows is still secret-only by default;
`test/check-http.mjs` asserts both halves, that `ensure` is in and that an unnamed action is out.

## 18. The boundary cue is played, not attached to the notification — 2026-08-05

**Status:** superseded by 20

**Context:** a per-phase sound — one for work, one for the short break, one for the long break —
cannot be expressed as a property of the notification, because the daemon has two notification
paths and only one of them can name a sound. The bundled install posts through
`UNUserNotificationCenter`, whose `soundNamed:` resolves against the app bundle's own Resources;
nothing audio is in there, and entry 9 already priced why putting something there is expensive
(new bytes in the bundle change its ad-hoc signature and cost the reader their TCC Documents
grant, in a repo that lives in `~/Documents`). The clone install's `osascript` fallback *can*
name any of the 14 files in `/System/Library/Sounds`. Attaching the cue to the notification
therefore makes the setting work on the degraded install and silently collapse to one generic
sound on the normal one — a preference that visibly does nothing.

**Decision:** the cue is a separate thing the daemon plays itself, `afplay
/System/Library/Sounds/<Name>.aiff`, and the notification is always posted silent on both paths.
`with_sound` and the `--sound` flag lose their only caller.

**Consequences:** one code path, so the three cues are genuinely three sounds on every install,
and the choice is a name out of a directory listing rather than a capability of whichever
notifier is present. The price is that macOS no longer owns the cue: a Focus that silences
banners does not silence this, the cue does not appear as claude-board's notification sound in
System Settings, and the reader's only mute is setting the phase to `None` in the widget. That
is the accepted trade — a pomodoro cue that a Focus swallows is a cue that fails exactly when
the reader is concentrating. It also turns "does turning notifications off silence the cue too"
from a fact of the mechanism into a decision somebody has to make. Rejected alongside the bundle-Resources route: a
symlink farm in `~/Library/Sounds` to make `soundNamed:` resolve, which is undocumented
behaviour on macOS and would have to be created and cleaned up by the installer.

**Amended by entry 19, 2026-08-05 — and not yet implemented.** Nothing in the repo plays an
`afplay` cue today; this entry is a decision waiting for the per-phase sound setting it was
written for, and the pomodoro's setting is still the boolean `sound` it always was. What entry 19
changed underneath it: the `UNUserNotificationCenter` path this entry describes as hypothetical
now exists (`bin/notify.m`), and `with_sound` / `--sound` are real and do have a caller —
`src/notify.mjs` passes `--sound` when `settings.sound` is true, and the notification carries
`UNNotificationSound.defaultSound`. That does not contradict the decision above, because the
collapse this entry objects to is specific to *per-phase named* sounds: one generic tone standing
in for three distinct cues is a preference that visibly does nothing, whereas one generic tone
standing in for a boolean "make a sound" is the preference working. When the per-phase cue lands,
the decision holds and `with_sound` loses its caller exactly as written here.

## 19. The pomodoro notification is posted by the bundle, not by osascript — 2026-08-05

**Status:** accepted

**Context:** three things about a macOS notification — the name on it, the icon on it, and which
row of System Settings > Notifications governs it — all come from the bundle of the process that
posts it, and nothing can override them: there is no API for the icon, and Banner-versus-Alert
(the difference between a notification that vanishes in five seconds and one that stays until
dismissed) is a per-app setting only the reader can change, in System Settings, for whichever app
posted. The daemon is `node`, which has no bundle, so it shelled out to `osascript` — and got
Script Editor's name, Script Editor's icon, and a row labelled "Script Editor" as the only place
to make a pomodoro boundary persist. Entry 9 accepted that as the price of not touching the
launcher bundle's signature. Entry 15 then folded the daemon's own code into that signature, at
which point every code-carrying install already rebuilt, re-signed and re-prompted, and the price
entry 9 was paying for had stopped existing.

**Decision:** `claude-board.app` posts its own notifications. `bin/notify.m` (a
`UNUserNotificationCenter` post) is compiled into the launcher binary, `bin/launcher.c` gains a
`--notify <phase>` mode that runs it and forks nothing, `src/notify.mjs` spawns that mode when it
can see it is running from inside the bundle, and `bin/claude-board.icns` — the board mark from
`src/styles.mjs`, the same one the favicon draws — becomes the bundle's icon and therefore the
notification's. `osascript` stays as the fallback for the no-launcher install, which has no bundle
to post from.

**Consequences:** the notification says claude-board, carries the board's amber mark, and has its
own row in System Settings where the reader can set Alerts and have boundaries stay on screen —
which is what makes the pomodoro visible to someone who is not looking at the board. Three things
this costs, all of them accepted:

- **A launcher that links two frameworks and reads argv.** Both are confined to a mode launchd
  never invokes: `main()` matches `--notify` before it installs a signal handler, and the
  supervising path still takes every path it uses from compiled-in constants. What argv chooses in
  that mode is one index into a closed table of three sentences, never a string that reaches the
  screen — the same posture as everything else in that file.
- **One more permission prompt.** `install.sh` asks at the end of an install the reader is
  watching, rather than leaving it to appear hours later at a boundary with no context. A reader
  who says no gets no notifications and a working daemon; the fix is a toggle in System Settings,
  which the installer prints.
- **A registration step.** A newly installed bundle is refused notification rights outright until
  LaunchServices knows about it, so `install.sh` calls `lsregister -f` before it asks
  (QUIRKS.md). It is a private path, so the call is guarded rather than depended on.

Rejected: a second app bundle whose only job is notifications — the shape entry 9 named as the way
to revisit this. It leaves `launcher.c` untouched but buys a second compile, a second ad-hoc
signature, a second uninstall path and a second row in System Settings, and the entry-9 reason for
wanting `launcher.c` untouched had already lapsed. Also rejected: a helper executable inside the
existing bundle, which is not merely worse but impossible — macOS grants the bundle's notification
identity to its `CFBundleExecutable` and refuses every other binary in `Contents/MacOS` with
"Notifications are not allowed for this application" (measured; QUIRKS.md). That is the constraint
that decided this entry's shape.

## 20. The system sounds are staged into the bundle, so macOS owns the cue — 2026-08-05

**Status:** accepted. Supersedes 18.

**Context:** entry 18 decided the per-phase cue would be played by the daemon itself, because
`UNNotificationSound soundNamed:` resolves a name against the app bundle's Resources and
`Library/Sounds` — never against `/System/Library/Sounds`, which is where the 14 sounds a reader
would want actually live. (`/System/Library/Sounds` *is* reachable from AppleScript's `sound
name`, which is why the degraded clone install could always name a sound and the bundled install
could not. The old `NSUserNotification` API read it too; the modern one does not.) Playing the
file directly sidesteps that, and it is what entry 18 chose.

Grilling the setting surfaced what that costs, and the cost was refused: a cue the daemon plays
is not a notification, so macOS cannot see it. Turning claude-board's notification sound off in
System Settings, turning its notifications off entirely, or switching on a Focus each silence the
banner and leave the cue ringing. The reader's only mute becomes a switch in this app's own
popover, which is the opposite of "filter it where every other app is filtered".

Entry 18 also mispriced the alternative. Entry 9's objection to changing the bundle is that new
bytes change its ad-hoc signature and walk back the reader's TCC Documents grant — but entry 15
folds a digest of every file under `src/` into the rebuild stamp, so any release that touches
`src/` already rebuilds and re-signs, and already walks that grant back. A release adding a
pomodoro setting touches `src/` by definition. The marginal cost of adding sound files to that
same install is therefore zero re-approvals, not one.

**Decision:** `install.sh` copies `/System/Library/Sounds/*.aiff` into
`$STAGED_APP/Contents/Resources`, at the point it already stages `bin/daemon.mjs` and `src/` and
ahead of the `codesign` call, and the rebuild stamp's payload digest widens to cover them. The
cue is once again the notification's own sound, named per phase — `UNNotificationSound
soundNamed:` on the bundled path, AppleScript's `sound name` on the clone path, the same 14 names
either way. Nothing audio enters the repo; the files are copied from the OS at install time, on
the machine that already has them.

**Consequences:** every macOS control over notifications now reaches the cue, which is the whole
point — a Focus silences it, the per-app sound toggle silences it, and the reader tunes this
where they tune everything else. Three distinct cues survive on both installs. The bundle grows
by roughly 4.7 MB, `install.sh` grows a copy step, and a reader on a Mac whose
`/System/Library/Sounds` is non-standard gets whatever is actually there rather than a fixed
list, so the enumeration and the staging must read the same directory or the picker will offer
names the bundle cannot resolve. The picker's preview is the one thing that does not go through
Notification Center: auditioning a sound must not raise a banner, so the preview plays the file
directly and is deliberately outside macOS's filtering.

Rejected: symlinking the 14 sounds into `~/Library/Sounds`, the other directory `soundNamed:`
searches. It needs no bundle change and no megabytes, but `~/Library/Sounds` is a shared
namespace — those entries appear in every other app's sound picker and in Sound settings — so it
makes this app's install visible in a place that is not this app's, and `uninstall.sh` grows a
cleanup step that has to distinguish its own symlinks from a reader's own files.

**Open before implementation:** that `soundNamed:` genuinely refuses `/System/Library/Sounds` is
taken from Apple's documented search path, not measured on this machine. It is the fact this
entry rests on. Measure it first: if a bare name already resolves against the system directory,
the staging step and these 4.7 MB are unnecessary and the decision collapses back to "name the
sound, change nothing else".
