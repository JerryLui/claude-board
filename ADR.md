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

## 13. The index's search box filters sessions; it does not search inside them — 2026-08-04

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

## 14. The pomodoro switch may start a timer, so the session cookie may call `ensure` — 2026-08-04

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
