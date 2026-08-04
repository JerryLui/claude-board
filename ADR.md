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
