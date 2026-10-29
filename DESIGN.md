# claude-board — design record

The reasoning and the rejected alternatives behind the decisions the record rules on. `ADR.md`
and the entries in `.agents/adr/` say what is true now; this says why, and what was on the table
instead. Where the two disagree, the entry wins. Tracked, because tracked files cite it — a
pointer into a gitignored file resolves only in the checkout that happens to hold it. The
reader-facing documents are still `SECURITY.md`, `CHANGELOG.md` and the README; this one is for
whoever is about to change a decision.

Reached by name from the `.agents/adr/` entries that link it, and from a shifting set of source
and check files that cite one section of it directly. `git grep -l 'DESIGN.md'` is that list, and
it is deliberately not written out here: a citer added on one branch makes any spelled-out list
false on another, which is exactly how the previous version of this sentence rotted.
**Every entry that links here has a section of its own below,
addressed by its number.** That is the shape to keep: a link is the only way anything in this
file is found, so an argument no entry points at has no reader.

## Problem

Every review surface in the workflow is one-directional, and the one bidirectional surface is a
straw: `AskUserQuestion` takes at most four questions per call, in a terminal, with a label and one
sentence of context per option. A grill with a dozen open branches becomes a serial interrogation,
each question stripped of the code, diagram or spec section needed to answer it. Reviewing anything
visual is the same problem from the other side: describing a reaction to a diagram in prose when
pointing would take two seconds. Kun Chen's Lavish solves the annotation half by rendering the plan
as an HTML artifact you annotate element by element, queueing a dozen targeted comments and sending
them in one shot. The batching is the win, not the styling.

**Anchoring's problem, found later.** Pointing at the thing is the gesture the board exists for,
and it did not work: clicking elements inside a stage did nothing at all, with no comment form, no
error and no console message. It had been marked delivered on unit checks over the pure anchor
module and string assertions over the client script, neither of which can observe a listener
attached to a document that no longer exists. Underneath that defect was a shape problem: anchoring
had been built per stage kind, so the two exotic cases were the only ones modelled and everything
the reviewer actually reads was uncommentable below block level.

**Status's problem, found later.** Once a person ran a dozen agent sessions at a time, the board
answered their questions but said nothing about the work around them: which session needed them,
which had stalled, which had landed. Status was asked by hand, session by session, and the person
was the only link between sessions, carrying merge orders and approvals across by pasting.

## Solution

A **local review service**: one always-on UI daemon on this machine, plus a thin MCP server every
Claude Code session speaks to. The agent hands the daemon a **board** — an ordered list of blocks,
some rendered content, some questions — and blocks on the answer. A browser page opens. The
reviewer sees every question at once with its real context beside it, answers them in any order,
comments on any block, and submits once. The tool call returns the whole packet as structured data.

Two modes, one primitive. A **question board**'s blocks are questions, replacing the
`AskUserQuestion` loop for anything wider than a couple of questions. An **artifact review**'s
blocks are a rendered artifact, with question blocks interleaved where it has open decisions. A
board is a running thread, not a page: successive rounds land in the same open tab. The board was
also intended as the one rendering surface for every command, the other skills dropping their
private design systems for a block list; `ADR.md` entries 5, 11 and 102 record where that landed.

**Anchoring's solution.** Any element the reviewer can see can take a comment, through one model
over the board's own rendered DOM. Diagrams and mocks become two cases of that model rather than
the two cases it was designed around.

**Status's solution.** The board keeps a mission per piece of work beside its rounds, written by
whichever agent works on it, and its home page shows every mission in a column by state, live,
with the one-click answers a card can honestly offer. Decisions plus status, on one surface
(entries 123 to 129).

## Decisions

The founding argument, from before there were numbered entries. Nothing here states current
behaviour; the entries do.

**A local service, not a clipboard round trip.** An earlier draft passed feedback back by having
the reviewer copy a structured block and paste it into the session. That buys zero infrastructure
but leaves the agent blind until the paste lands and makes every round trip manual. Since the
point is to replace the `AskUserQuestion` loop rather than decorate it, the answer must come back
as a tool result.

**MCP stdio server per session, one shared daemon.** A tiny stdio server is registered once in
the Claude config; Claude Code starts one per session, so it knows the session's project
directory for free. Rejected: an always-on HTTP MCP daemon (one less moving part, but it never
learns the project directory and a dead daemon shows red in every session) and a plain bash CLI
(nothing to register, but answers return as command output rather than a structured tool result,
and the wait would depend on background-execution semantics that are not clearly documented).

**The blocking tool call is the wait.** MCP tool calls tolerate a long wall clock, so the tool
blocks until submit rather than polling or asking the user to type "done". Rejected: intercepting
`AskUserQuestion` with a `PreToolUse` hook, since hooks can allow, deny or comment on a call but
cannot supply its result; and MCP elicitation, which renders a flat form in the terminal, the
surface we are escaping.

**One block document, two modes.** Both modes emit the same shape, so there is one renderer, one
submit path, one test seam (`PROTOCOL.md` carries the shape). Rejected: two renderers sharing only
CSS (more freedom per mode, double the code, guaranteed drift) and folding artifact review into
one giant context block above the questions (cheapest, but you could no longer anchor a comment to
acceptance criterion 4 specifically, which is the point).

**JSON is truth, the page is a projection that carries its own copy.** A board is a JSON document
in the store and the daemon mutates only JSON; the HTML page is a pure function of that JSON,
emitted with its source inlined. Re-rendering old boards after a design change is a loop over the
store, not a migration. Rejected: making the HTML file itself the mutable artifact (every write
becomes an HTML edit and every read a parse) and keeping JSON only with no file emitted (cleanest
model, but nothing opens without the daemon and there is no archive to double-click in six
months).

**Send is never gated.** One always-enabled Send. Every question carries an implicit unanswered
state and an optional free-text note beside its choice; unanswered comes back explicitly marked,
never defaulted and never silently dropped. Rejected: required-unless-optional (makes the agent's
guess about what is required into the reviewer's problem, and removes Send-early) and streaming
each answer (the agent is blocked in one call and cannot act on partials anyway).

**A board is a session-scoped thread with rounds.** Each session gets one stable board URL and
one tab; a follow-up round lands in that page rather than a new one, and the agent may amend a
round that is still open without disturbing filled-in fields. Rejected: a new immutable page per
round (simpler server, tab sprawl, no amendment) and replacing the tab's content each round (loses
exactly the accumulated context that makes a board better than the terminal). [The sent round
originally collapsed into a *history rail* below the open one. `ADR.md` entry 42 deletes the rail
and makes rounds the board's pages; the thread-with-rounds decision itself is untouched.]

**`/grill` asks in layer-sized rounds.** A round carries every branch that nothing unresolved
gates, its questions grouped by branch and posted together, up to the manual's round cap, a
wider layer splitting across rounds. Rounds track the
depth of the decision graph, not the number of branches in it. Rejected: branch-sized rounds, one
branch per round, which serialises branches that merely sit near each other in the design. A lone
follow-up or a yes/no still goes through `AskUserQuestion` in the terminal, because opening a tab
for one question is worse than answering it inline. [No longer: once the person answered on the
board while a dozen sessions ran, a question in one terminal was a question unseen, so the manual
now sends every question to the board, one question being a round of one, and a host may refuse
the in-chat popup while the board is up. The popup is the fallback only while the board is down.]

**Questions by value, content by reference, snapshotted at post time.** Content passed as a
reference stays cheap and faithful because it never passes through the model; prior art is
`/visualize`, which splices markdown by reference for the same reason. The reference is how the
agent *addresses* content, not how it is *stored*: the daemon resolves it once at post time and
copies the resolved text and its sha into the board JSON, so an archived board survives the source
being rewritten. Accepted cost: the page no longer follows live edits, which surface on the next
round instead. Rejected: lazy re-reads at render time (live-following, but an old board renders
differently than when it was answered) and passing rendered content by value from the model (large
every round, and exactly where paraphrase creeps in). The reference's shape is `PROTOCOL.md`'s;
where it may point is `SECURITY.md`'s.

**Four widgets, and context beside the question.** Free text alone is a capability the terminal
tool lacks, which is why open questions currently get degraded into false multiple choice; the
side-by-side comparison stage is inherited from `/example`, used whenever two candidate designs
exist. `PROTOCOL.md` enumerates both sets.

**Click-to-comment reaches individual elements.** A comment anchors to the element clicked: a
reference plus a text hint, with mermaid's own node id kept alongside for diagrams, so the agent
receives "the Send button in the after stage" rather than "the small card". This is the gesture
that made Lavish worth copying, and it lands in the first version so archived boards stay valid.
Rejected: coordinate pins (never fail to anchor, but a percentage offset means nothing to the
agent without shipping the picture too) and block-level anchors only (leaves UI review at "the
card in the second stage"). Which blocks offer the gesture is `ADR.md` entry 28's.

**Anchors at headings and list items — withdrawn, kept as an argument.** Every named section would
be a block and every top-level list item its own anchor, so an acceptance criterion or a single
decision bullet could each take a comment while ordinary prose commented at section level. Rejected
at the time: headings only ("criterion 4 is wrong" degrades into a comment on the whole section)
and every leaf node (a hover target on every line, and ids that churn on the smallest edit). Entry
28 withdrew the decision outright by dropping `markdown` from the commentable kinds. Kept because
it is the argument any future case for re-earning heading anchors would start from, and because
"rejected: every leaf node" is still the right call for the two kinds that remain.

**Open once, then badge and banner.** The first board of a session opens the tab; later rounds land
in it and mark it, and the mark says something is pending rather than how much. Whether anyone is
*looking* is a separate question from whether a tab exists, which is why the daemon raises a native
banner of its own rather than trusting the tab to be seen: a closed tab, a hidden tab and an
unfocused tab all read the same. Rejected: never auto-opening (a posted board sits unnoticed while
a call blocks), opening every round (steals focus and spaces mid-sentence), and a page-side
notification tied to Chrome's per-origin permission grant (three grants for the same board reached
three ways, and a denial there was unrecoverable in place). The vocabulary for these states is
`CONTEXT.md`'s; the notifier is `ADR.md` entries 55 and 58.

**Two ways out, plus a wall clock.** Beside Send the board carries **Discuss in chat**, returning
the call immediately with whatever is filled in and a status telling the agent to stop posting
boards. Closing the tab is deliberately not a cancel — the board stays live and the URL reopens —
because browser disconnects are unreliable, a sleeping laptop reading the same as a deliberate
close. A wall-clock cap returns no-response rather than letting the call sit for the MCP default of
roughly 28 hours; its value is `ADR.md` entry 47's.

**Node, zero dependencies, its own repository**, cloned per machine and run from the clone, with
board JSON and emitted pages outside it so review content is never committed. Rejected: living
inside the synced Claude config repo (a pull reaches every machine without a clone, but it welds a
general-purpose tool to one person's private config and forecloses ever handing it to anyone else),
express/ws (much less code, but a dependency tree and an install step everywhere the repository
reaches) and python stdlib (the prior art and its runnable check are both node).

**Always on under launchd.** A managed service started at login, not spawned on demand, so a board
never waits on a cold start; because a restart can still land mid-review, the store is on disk and
the shim reattaches by board id. Rejected: lazy spawn from the shim (no plist to install, but the
shim would own a lifecycle it cannot supervise), and auto-reload on a source change — tried twice,
and "manual restarts guarantee debugging a stale build eventually" turned out to be the cheaper
failure, since a stale build is visible and fixable in one command and a review interrupted by
somebody's save is not. `QUIRKS.md` has what `WatchPaths` actually does.

**The daemon renders markdown; the page renders mermaid.** Block splitting and markdown-to-HTML
happen server-side, in a module that runs in both node and the browser, which is also what makes
it testable without a browser. Mermaid stays client-side: server-side mermaid means a headless
browser and ends the zero-dependency rule.

**A thread per session, addressable from an index.** One thread per shim process, which is exactly
one per Claude session, labelled with its project directory. The daemon root serves an index of
threads with pending counts, so a closed tab is one click away instead of a URL buried in
scrollback. Rejected: keying threads by project directory (fewer tabs, but two sessions in one
repo interleave questions with no way to tell who asked, and answering can unblock the wrong
agent) and a bare URL per board (no history, no recovery).

**Fail loudly, never degrade silently.** The original decision: if the daemon is unreachable,
every board-posting command reports it with the command to revive the service and stops, with no
automatic fallback to the terminal, because a feature that quietly downgrades is a feature that
stays broken for a week. Rejected then: splitting behaviour by cause (fall back when the tool is
absent, fail when it is broken) as too subtle to reason about mid-session. **Overturned by
`ADR.md` entry 4**, which found the cost larger than priced: refusing a non-interactive session by
design made every migrated command unusable headless. Every command now carries a non-board path
and announces taking it. What survives of the original is the announcement: a degraded path is
never silent.

**One install command, because a clone is not enough.** Two things sit outside the repository and
neither can be committed: MCP registration, which Claude Code owns, and the launchd plist, which
must carry the clone's absolute path. An idempotent install script does both.

**One blocking tool, with a known escape route.** The MCP surface stays a single `ask` that
blocks. If either mechanic it leans on regresses, splitting into a post call and a collecting call
is contained, because the daemon's HTTP surface already separates posting from waiting underneath.
Rejected: shipping that split now (a permanent second tool to hedge a documented behaviour, plus a
board that can be posted and never collected) and hiding retries inside the shim (retry against a
call that may already have consumed the answer is the subtlest bug available here).

**The gates started at a loopback `Host` check and nothing more, and that was wrong.** Rebinding is
closed by it, but a page on any origin doing `fetch('http://127.0.0.1:…')` sends a loopback `Host`
itself, and both POST routes were CORS simple requests, so no preflight could block them. Three
amendments followed, ending with reads gated behind a credential the browser holds. `SECURITY.md`
carries the shipping posture and the reasoning for every gate in it.

**Archived boards are searchable**, because moving questions out of the terminal means scrollback
stops being the record of what was decided, and "what did I decide three sessions ago" would get
worse than it is today.

**Findings: the board decides, the existing applier applies.** `/audit` keeps writing its findings
file and the board renders one block per finding with accept, reject or defer; the returned packet
drives the applier `/triage` already has. The board replaces the reading-and-deciding step, which
is the painful one, and leaves the code-editing step with its current semantics and risk profile.
Rejected: retiring the findings file and rebuilding the applier around the packet in the same
version that introduces the service (a bug in either would look like a bug in both) and rendering
findings read-only (a nicer wall of text, same decision loop).

**The renderer stays mechanical.** An agent supplies block references and question text, never
drafting or paraphrasing the content it renders, and stays read-only toward everything it reads. A
rendered board is always a faithful view of its source.

### Anchoring decisions

**The failure was a verification failure first.** The board spec put browser automation out of
scope and left the interactive layer to "open a board and use it", which nobody did until the work
was otherwise finished. Unit checks over the pure module and string assertions over the client
script both passed against a feature that never once worked. So the click path is exercised for
real, and a criterion is not checked off on the strength of the modules beneath it.

**Mermaid stops being the template.** Node ids are a lucky property of one diagram renderer, and
designing the anchoring model around them is what left ordinary content uncommentable. The generic
model comes first; a diagram node is anchored by it like anything else, with the node id kept
alongside as the more durable of the two. See entry 28 below.

**Isolation of hand-mocked HTML is kept.** A mock renders isolated so its CSS and markup cannot
leak into or clash with the board page, which is why it renders unstyled, and that is correct
behaviour rather than a defect. Faithful preview beats a uniform implementation: the cost lands on
anchoring, which carries one cross-document case, with the pin drawn in the board's own layer over
the isolated content.

**The gesture is an explicit comment mode.** With the toggle off the page behaves exactly as it did
before anchoring, which makes "anchoring never steals an ordinary interaction" true by construction
rather than by careful guarding of every widget; with it on, hovering names the element that will
be anchored before the reviewer commits. Chosen over a held modifier, which nothing on screen would
advertise, and over hover-plus-click on anything that is not a control, which puts text selection
and every widget edge permanently at risk. The toggle governs **everything** without exception: the
stage and the diagram were initially left clickable at all times, on the reasoning that nothing
inside an isolated mock or an SVG is a real control to steal, which was sound but put two gestures
on one page (decided with the user 2026-07-29).

**The click check runs in a DOM stand-in inside the repository**, zero-dependency and part of the
ordinary check command, driving the real client script through a click. Its own credibility is the
first thing established: it is written against the broken code and must fail there before it is
trusted, because a stand-in that models the browser wrongly is exactly how this feature shipped
dead twice. A browser is still where reality lives, so the stand-in reproduces the specific
behaviour the defect turns on — a document being replaced under an already-wired listener — rather
than approximating a browser in general.

**An anchor survives re-render, not editing.** Content is snapshotted at post time, so the
anchor's job is to survive the board being rendered again from its stored JSON. Anchoring into
content that has since changed is not promised.

### Polish decisions

**Comment deletion is scoped to unsent comments only.** `board.comments` is append-only
server-side and a comment's `n` is its pin number and the identifier the agent reads out of the
packet. Deleting a sent comment would either leave a gap in that sequence or renumber pins the
agent has already been handed. A queued comment lives only in the page's own pending state, so
removing one is pure client state: no protocol change, no endpoint, no renumbering.

**A second click on an anchored element edits, it does not add.** Rejected: keeping multiple
comments per anchor legal and only warning about duplicates (preserves leaving two separate
remarks on one element, but keeps the accidental-duplicate case that prompted this) and
click-to-toggle-delete (fastest, but destructive on one click with no confirmation, and ambiguous
once a sent comment already sits on the same element).

**Except inside an html stage, where a repeat click queues a second comment** (2026-07-31, product
call, approved). A malicious html block can forge a `click` message and make the reviewer's next
submit REPLACE an earlier queued comment; the parent cannot distinguish a real click inside a
sandboxed, not-same-origin iframe from a forged one, so no discriminator buys both edit and
safety on that path. Minting stays forgeable — visible, deletable. Destroying a comment the
reviewer actually wrote does not.

**The delete control is an `×` on the comment's list entry, not on the pin.** The entry already
carries the pin number and anchor tag and is already click-wired to highlight its element; pins
are 20px, `cursor: default`, and overlay content.

**A sent comment's element stops being a comment target entirely.** Not prefilled, not
read-only-prefilled: clicking it in comment mode does nothing, de-affordanced so that is visible
before the click, which closes the gap between "delete is unsent-only" and "a second click edits".
The de-affordance rides comment mode's existing hover reinterpretation rather than marking the
element permanently, so the reading view stays unmarked.

**Only code blocks get a scroll cap; long prose folds.** Code keeps the scroll box below. Markdown
past about a dozen lines folds under a fade with a Show the rest control that opens it in place (ADR 110),
decided by a count of its source rather than measured pixels, so the check suite can assert it;
this reversed the earlier "markdown is never capped" rule once a question's context started
carrying whole spec sections beside a short explainer. Rejected there: scroll-in-place for prose (a
reader loses the page's own scroll inside the item) and folding a diagram or a mock under a fade
(cut in half, unreadable). A mock later got a fold of its own that scrolls instead of clipping
(below); a diagram still does not fold. Mermaid gets a lens instead, because a scaled-down diagram
is unreadable rather than merely long. (The first draft justified the code cap by "`.html-stage`
is already capped", which was false then: it was FLOORED at 320px. Only the supporting claim was
wrong.)

**The cap is `max-height` + `overflow: auto` + `resize: vertical` at ~480px**, one idiom for every
long stage on the page. Rejected for code: a fade-and-Expand toggle (sidesteps the pin-position
problem but adds new markup, a class and new JS; it is what prose got later, where there is no pin
to place) and a bare cap with no handle (leaves the reviewer no way out when 480px is genuinely
too short). **The recipe was assumed rather than built, and does not work
alone:** `max-height` clamps a box permanently, including against the explicit inline `height` that
the element's own `resize: vertical` drag sets, so "can be dragged taller" is unreachable from CSS.
Shipped fix is `unlockCodeCapForDrag`, which swaps the cap for a plain `height` read off live
layout once the block is confirmed actually capped.

**Pins in a capped code block are clipped, not repositioned.** A pin for an off-screen line hides
rather than being drawn at the wrong line: "not shown" instead of "shown wrong", the safe
direction. It shares no machinery with the pre-existing `.html-stage` pin drift, which stays
deferred.

**The round badge states position and total, not just total.** Rejected: leaving the label as-is
and only making it clickable (preserves exactly the ambiguity that prompted this) and a per-round
chip switcher (honest and scalable, but pointless on a single-round board). Position is read off
an IntersectionObserver rather than a scroll handler, and clicking jumps to the round that still
needs an answer, because the badge's job is "take me to the thing that needs an answer".

**Mermaid gets a lens, and it is commentable.** Commenting from inside the lens is the point, not
a bonus: a diagram big enough to need zooming is exactly the one you cannot comment on accurately
at inline scale. A lens comment is the same comment as an inline one, so it pins on the inline
diagram after Send. Rejected: a separate overlay recomputed on every pointer move (the
scroll-tracking cost just avoided on code blocks) and letting pins scale with the diagram (buries
the node under its own pin at high zoom). Two traps the lens inherits from `/explain`'s — a cloned
SVG duplicating element ids, and pointer capture retargeting the click — are in `QUIRKS.md`.

**A stage fits its content, and folds past 600px by scrolling, not clipping** (ADR 119). Every
stage outside a page board takes its reported height up to 600px, the rendered-variant cap it
already had; past that it stays 600px tall and scrolls inside, and Show full height in a bar under
the frame grows it in place to the whole artifact, with Show less folding it back. It replaced a
fixed 320px box with inner scrollbars and a drag grip, through which a mock inside a question was
judged as if through a keyhole. Rejected: always full height (a long mock pushes the options a
screen down), keeping the box and relying on the lens alone, and clipping under a fade the way prose
folds, which breaks in-page links, keyboard focus and fixed footers inside the mock unless each
gets its own handling. Top-level stages fold too, one rule as prose folds everywhere; a variant
option keeps its clip with no bar, since a click on its card picks it. Four rules came out of a
red-team round, each against a mock that sizes itself from its own frame:

- **An open is a one-time snapshot**, capped at 30,000px. A mock sized in viewport units grows with
  the frame it is measured in, so an open that followed its reports would never stop growing.
- **Below 320px only on two matching reports**, never under 120px. A mock that lays out from the
  viewport can measure as a sliver before it has built itself; the stage posts each new height a
  second time after a re-measure, so a short mock that has settled says so twice.
- **One applied height per animation frame, grow at once, shrink after a 300ms settle, 32px of
  slack under the fold line.** A mock whose height keeps moving (an animation, a loader) would
  otherwise jump everything under it, or flicker the bar in and out at 600.
- **A stage holding a comment renders opened, decided by the server.** A board opened in a
  background tab gets no height report until it is shown, so the browser cannot know where the
  fold line is; opened, a pin is never under a fold the reader has to find first.

The height is measured from the whole document, not the body, so a margin collapsing through the
body does not leave a fitted stage a stray scrollbar. An in-page link in a stage with nothing to
scroll (fitted, or opened) asks the board to scroll to the target instead, and every applied
height re-asks the stage's pin positions, since a new box moves a centred or bottom-docked element
with no scroll to notice it.

**One Pull-out in the corner of every stage and diagram opens the lens** (ADR 120). A 28px button
in the frame's top-right corner, wherever the frame sits, is the only way in; it replaced the
label-row and tools-row pills, which a stage inside a question never had at all. It opens the
existing lens on the board page, which copies the stage's sandbox, so it adds no security surface.
It is always visible, never hover-only: nothing on the board hides until hover, and hover does not
exist on touch. It hides while comment mode is on, so the artifact's own top-right corner stays a
comment target (the stage lens is view-only), and it stays live on a sent round and in an archive,
since opening a mock to read it is not an answer. Rejected: a corner button on stages only, on
context stages only, and opening the stage in a new browser tab, which needs a new daemon address
serving agent HTML and a security round of its own. The cost is the corner itself: the control
covers the artifact's own top-right corner. A page board and a block that failed to render carry
none.

**A Pull-out on a held stage says on screen why nothing opened**, which follows from ADR 120's
always-visible control meeting ADR 122's held frame: such a frame has no stage to copy until a
fill lands it, so a press opens nothing, and a reason given only in a tooltip is one a reader who
clicks never sees. The control's `title`/`aria-label` say it, and so does a note in the board's
own document, over the frame's corner, left of the button: "This stage is still loading. Open it
full size once it shows." while the fill the press started or joined is out, or "This stage did
not load. Press again to retry, or reload the page." once that fill settles with the frame still
held. The note is `aria-hidden`, since the control's label carries the same words. A round push
that keeps the frame keeps the note and the control's words, and any fill that puts the stage
into the frame takes the note away and gives the control back its own words, so the Lens never
opens beside a note about a stage that already loaded.

**References may resolve inside a configured allowlist as well as `cwd`.** `cwd` confinement alone
means a session can never render the skill, command or agent file it is discussing, a real and
recurring case in this repo. Read-only by construction, since resolving a reference is only ever a
read. `ADR.md` entry 3 rules on it and `SECURITY.md` owns the boundary, including why the default
is three narrow roots rather than `~/.claude`.

**The index row leads with the title and demotes the path to a folder name**, because the path was
the headline and on a machine working mostly in one repo every row headlined the same string.
Rejected: the folder as a pill beside the pending badge (a column of identical pills on a
single-project machine) and grouping rows under a per-project heading (factors out the repeated
path but breaks live-first sorting, since a live thread in the third group would sit below settled
threads in the first). A row also states its round count and its time relatively, since triage only
ever asks "which of these is fresh"; rejected there was a shortened absolute, which needs no script
and never goes stale but still answers the wrong question.

### Card decisions

**Every block is a titled card** (ADR 133). A card opens with a head row: its title on the left
(the block's `title`, a question's prompt, or a markdown block's opening heading lifted out of its
body), a stage's or a diagram's comment button after it, and the status chip last, at the card's
own right edge, its tone one of good, warn, bad or neutral (a question's chip is its answer state,
Answered or Deferred, live). Under the head sit the optional one-line summary, the content, and a
closed Details fold (`detailsLabel` names it). Long text folds behind Show the rest. No block names
its own type: the Markdown, HTML stage, Compare, Mermaid and Question captions are gone, and a
question that takes several picks says so in a line under its prompt. A block with no title and
no chip has no head, so an untitled markdown card starts with its text, and an untitled item in
a question's context stays bare prose in the panel; a titled one there wears the head at a
smaller scale. The look is the evidence card's, made the board's own so an evidence page is built
from ordinary blocks and the two cannot drift (ADR 132 gives every block the fields). Rejected:
flat sections, text set on the page with no card, which leaves two kinds of block.

**Cards in Linear's density, at every width** (ADR 138). A round page's cards share the home
page's density: 13px card text, 14 by 16 padding, 8px corners (`--r-card`) and 8px between cards;
a card's title 13px semibold and a nested title 12.5px; the board's title 20px semibold; an
option 13px with its description 12px; markdown headings 16, 14.5 and 13px.

**From a 1440px window, one centred 1100px column** (ADR 138). Every card on a board page, the
board's title and its meta line sit in one 1100px column (`--round-column`), centred on the window
with `margin-inline: auto`, and the window either side is plain page; the send bar keeps the same
edges. The header keeps the shell's width, up to 2560px, so its mark, buttons, wash and condensed
pill stay where they were; only its title block moves onto the column, by a margin that rides the
condense down to nothing. At 1440px the header's buttons narrow the title box to about 1011px, its
left edge still on the column. Inside a card:

- Prose carries no line-length cap: a line of text runs the card's width, about 130 characters at
  13px. Long open text (past its fold of about ten lines, and opened) flows into two columns, each
  half the card, which keeps most prose near 65 characters a line; short text, a folded preview,
  the card's summary, and text holding a table, code or a diagram stay one column.
- A question's options take the card's left half, never under 523px, with a 20px gap; its note and
  the Defer row sit under them at that width, and its context panel takes the right half, tables at
  their natural width. A question with no panel keeps the same columns, the second empty, so every
  question's options read at one width. A question whose options or context hold a stage keeps one
  full-width column, its context over its options (ADR 26).
- A diagram narrower than its panel sits in its middle; a picture opens full size from its corner
  Pull-out (ADR 120).

Under 1440px the layout is as before: the cards take the shell's width and prose keeps the old
1120px column's measure. A page board is one artifact filling the window and keeps no column.
Recommended was a 760px text column with tables, pictures and compares widening to 1360px on the
same centre, for lines of about 85 characters and bigger mocks; the person chose one width for every
card, accepting the longer lines and smaller mocks. This replaces the earlier choice of one wide
column on the header's left edge, which left a wide window's page against its left side, and with
it that choice's rejection of a centred column. Still rejected: cards that fit their content
(widths varied widely), and every card the window's full width (short text and narrow tables left
cards half empty).

**Inter, inlined** (ADR 139). The page sets Inter, its Latin faces at 400, 500, 600 and 700 inlined
in the stylesheet as `data:` URLs, with the system stack after it, so a face that fails to load
reads as the page did before. The rule it bends was "no web fonts and no external assets"; it is
now "no external assets": the font rides in the stylesheet's own bytes, so a saved copy still opens
with the network off. The cost is about 97 KB raw on the shared stylesheet, which the home page
links (at `/b/`) as a board page does rather than inlining it, so the browser's cache carries it
across loads; `test/check-pure.mjs` caps it at 120 KB. Recommended had been no font.

### Theme decisions

**OS preference supplies the default, an explicit choice overrides it.** Not OS-only (a
light-desktop reader could never choose dark); not manual-only (first load would be wrong for
everyone on light).

**Three states, not two: System → Light → Dark.** A two-state control pins the theme permanently
on first click, and the only route back to following the OS would be clearing site data, the exact
failure mode this work exists to avoid.

**The override lives in `localStorage`, applied before first paint.** `ADR.md` entry 1 closes off
server-side theming and records what the client-side choice costs.

**Archives follow the OS; the control still works for the sitting but persists nothing.** Not
because `file://` cannot store — it can — but because every `file://` document on the machine
shares one storage partition, so an ungated archive would read and write a preference belonging to
every other archive ever opened from disk. The gate is explicit, not a platform fact.

**Archives already on disk stay dark.** A page file is written at post time and never rewritten, so
every archive predating the change keeps the dark-only stylesheet permanently: no migration, no
re-render sweep on upgrade. Reopening such a board in the daemon serves a freshly rendered page.

**The palette was designed against the existing accent hue, not mechanically inverted.** Inversion
reliably produces washed-out accent text and near-invisible hairlines that would need
hand-correction anyway; an off-the-shelf light palette would cost the board its identity.

**Every raw colour literal below the token block is tokenized**, because those are precisely the
values that break in light, and leaving a subset behind leaves the stylesheet's stated invariant
half-true. The sandboxed stage stylesheet is the one exemption and keeps its literal: it is
injected into the same document as agent-authored HTML, so declaring the accent as a token there
hands that document a lever. `QUIRKS.md` "Two stylesheets, one palette" owns the trap.

**A stage is told the theme and stays a light surface.** The artboard behind a stage is a light
neutral in both palettes, so a mock that sets no colour has to draw the light scheme's defaults on
it in a dark board too. The board sends a stage its theme as `data-theme` and nothing else, and
both stage frames declare `color-scheme: light`: black text reads 12.28:1 on the dark palette's
artboard and an unstyled link 5.50:1. Measured in Chrome and rejected: stamping the board's scheme
on the stage's root (white default ink on the artboard, 1.71:1); dropping that stamp while the
frame still inherits the dark page's scheme (the two schemes differ, so the browser paints an
opaque white canvas in place of the artboard); an explicit black ink under a dark stamp (text
reads, an unstyled link stays the dark scheme's `#9e9eff` at 1.40:1, and form controls stay dark on
a light surface). A dark artboard under a dark board is the other way to settle it and a different
product, not chosen here. The cost: `prefers-color-scheme` inside a stage reads light whatever the
board's theme, and a template with a dark palette of its own declares `color-scheme: dark` itself.
The Lens's copy is sent no theme at all. `PROTOCOL.md` "The theme a stage is told" has the rest.

**Mermaid is re-initialized and re-run on every switch, then pins are re-wired**, so the
client script's duplicated palette becomes theme-derived rather than a second source of truth. Pin
survival is expected rather than hoped for, since diagram anchors key on the source-declared node
id.

**The control is icon-only**, three glyphs for the three states, state carried in the accessible
name and the tooltip. Icon-only is only an accessibility failure when the control has no accessible
name.

**Dark `--muted` moved from `#7b869a` to `#8690a2`.** "Both themes render exactly as they do today"
could not survive measurement: `#7b869a` is 4.45:1 on one surface muted text genuinely sits on and
4.03:1 on another. `#8690a2` is the minimal same-hue lift that clears 4.5:1 everywhere.

**Host canonicalization is out.** Redirecting non-canonical loopback hosts to one origin would
collapse the theme preference's storage split, but means changing security-reviewed `Host`
handling for a cosmetic preference.

### Round-end decisions

**The end-of-round rail ships alongside the arming Send, not instead of it.** The rail is purely
informational and composes rather than competing: the arming Send tells you something is left, the
rail tells you when nothing is. Both directions need covering.

**`deferred` counts as complete.** Defer is a real, deliberate verdict the widget already offers,
and treating a deferred question as outstanding would nag a reviewer who has already decided.

**An incomplete Send arms instead of sending.** Four treatments were rendered and compared as
mocks before deciding. This one reuses the arm/disarm pair the keyboard path already implemented,
so Escape cancels it and no new interaction model appears. Its cost was accepted: a deliberate
partial send takes one extra press, which is arguably what Discuss in chat already covers. There
is now exactly one armed state in the page rather than two that shared a flag while looking and
meaning different things.

**Swapping the bar's primary action was rejected.** The candidate made the accent button "Next
question ↓" while anything was outstanding and dropped Send to a dim tertiary, swapping the two
once every question carried a status. It moves Send's weight and position between states, so the
control a reviewer aims at is not where they left it.

**A counter alone was rejected.** Putting "2 of 5 answered" in the send bar was the cheapest change
available and the weakest: the button that misfires looks and behaves exactly the same, so it only
helps a reviewer who reads before clicking. This rejection is also the reason the live count pill
that later shipped is safe — what was rejected was a counter *instead of* the guard, and the guard
shipped first.

## Entry-addressed reasoning

One section per `.agents/adr/` entry that links here: the rejected alternatives and the tries that
failed, which the entry delegates rather than restating.

### Entry 20 — the cue is a bare name

**A cue the daemon plays itself is not an option**, which is what forces the bare name. `afplay` on
a path is a sound, not a notification, so it is reachable by none of the controls macOS gives a
reader for exactly this: not Focus, not the per-app toggle, not the notification switch. A cue that
cannot be silenced by the thing a reader would reach for is worse than no cue, because the only
remaining remedy is uninstalling the feature. Resolving a bare name hands the whole question to
macOS, which already owns every control that could answer it.

**The rejected alternatives.** Staging `/System/Library/Sounds/*.aiff` into `Contents/Resources` was
the first plan and does not work at all; `QUIRKS.md` has the measurement. Symlinking into
`~/Library/Sounds` was the second and
was refused because that namespace is shared: the entries would surface in every other app's
picker, and `uninstall.sh` would grow a cleanup step distinguishing its own symlinks from a
reader's. Shipping sound files had been priced as costing a re-approval, which entry 15 had already
made false: any `src/` change re-signs, so the marginal cost was zero.

### Entry 28 — element anchoring

Written before the implementation, as two memos in `src/anchor.mjs`, and kept here as the argument
rather than the mechanism. The mechanism is in that file; entry 28 is the ruling.

**One generic element reference over the board's own DOM.** The wire shape does not change:
`{ kind: 'dom', ref, hint }`, exactly what was already stored for a click inside a hand-mocked html
stage. What changes is which ROOT the index chain is measured from, and there are exactly two,
chosen by the anchored block's own kind — the same discriminator `resolveComment` already reads. An
`html` block roots at the stage iframe's body, because the click happens in a different document;
that stays the one cross-document case and nothing about it changes. Every other kind roots at that
block's own rendered `<section data-block-id>` in the board page's own document, found by walking up
from the click target to the nearest such ancestor. The block id a comment attaches to is the same
id the block's own comment form already uses, so nothing new is threaded through the wire format.

**Deliberately not a path from `<body>`**, which is exactly the kind of thing that shifts on
re-render: inserting an earlier round, or a block landing at a different position, shifts every
absolute body-rooted index. Rooting at the block's own stably-ided section means a ref only has to
survive that ONE block being re-rendered identically from its own unchanged stored content. So "one
model" means one path-building and path-resolving mechanism, with the html stage's cross-document
case and the page's own same-document case both examples of it, rather than the stage being the
only element-level case that existed.

> **Amended by entry 28 itself, 2026-08-06.** "Every other block kind" above is the memo's own
> design, predating the entry and now too wide. The mechanism is unchanged and still generic, but
> it is gated to `html` and `mermaid` before a click ever mints a ref: a paragraph, a list item, a
> table cell or a line of a code reference is no longer a click target at all, in a question's
> context or a compare side or anywhere else. `md` anchors are deleted outright, not merely left
> untouched. This is why the memos are addressed to entry 28 at all.

**How a hint is derived, and why the rule is a pure function.** An element's own collapsed text is
its *identity*, and that alone is not the hint the design asks for, which wants containing context
too — "the Send button in the after stage", not "the small card". The context half is necessarily
DOM-shaped and stays in the client. But the RULE for turning those already-gathered inputs into a
hint string, which is the thing the hint is actually graded on, is a pure function with no DOM in
its signature. The split matters for the same reason path building and path resolution are split:
it is what makes the composition rule checkable without a browser, and — per an earlier draft's own
mistake — a design comment describing a rule is not the same thing as the rule being checked. The
client embeds that function's literal source rather than re-implementing it, so there is one
implementation and not two that can drift.

The rule itself: hint is identity, or "identity in context" when context is non-empty. A role word
(button, link, image, field) stands in for identity when an element has no text, and is appended to
present text only alongside real context. Without something to disambiguate against, an element's
own text is already unambiguous on its own block, and suppressing the role word there is what keeps
the plain stage hint `'Send'` rather than `'Send button'`. Context is present only inside a compare
side, which is the one place in this codebase two symmetric, identically-shaped bits of content sit
side by side on purpose — exactly the ambiguity "the small card" versus "the Send button in the
after stage" is about. Everywhere else a block's own id disambiguates without restating it in every
hint. Never invented from the surrounding copy either way: the renderer stays mechanical.

> **Superseded, both forward references this memo left open.** It said a `dom` anchor minted
> against the new page-scoped root "reports `lost` the moment it round-trips", honestly rather than
> silently, until later work taught the server to re-render that one block and resolve against it.
> That work shipped: `src/board.mjs`'s `sectionRootForBlock` does exactly that, and page-scoped
> anchors resolve. It also flagged that resolution would one day have to match the identity portion
> of a hint rather than test containment of the whole string. That shipped too, and as equality
> rather than a prefix test: `domIdentityHintMatches` compares against the exact shapes the
> composition rule can produce, because a prefix test resolves a comment onto the WRONG element and
> reports it resolved.

**A diagram node folds into the generic model.** The order is deliberate: the generic model comes
first and a diagram node is anchored by it like anything else, with the node id kept alongside as
the more durable of the two — a fallback the generic model can lean on, never the model.
Concretely, a mermaid anchor keeps its own kind and its own `ref`, the source-declared node id
recovered from mermaid's generated element id, so every anchor already stored resolves exactly as
before. It gains the same two fields every other element-level anchor carries, rooted and composed
the same way, which is what lets a diagram node's hint read "Start in After diagram" instead of
carrying no hint at all.

**Precedence, and why it is not cosmetic.** The generic reference is tried FIRST, through the exact
same resolver every other kind's `dom` anchor goes through; the node id is the fallback. In
practice, for as long as diagram rendering stays client-side, the generic attempt fails
server-side every time: the block's re-rendered section only ever contains the raw mermaid source,
and the SVG a click actually landed in exists only in whichever browser rendered it. So the node id
is, today, the field actually doing the resolving — not because it is preferred, but because it is
the only one of the two a server that never runs mermaid can corroborate. The generic attempt is
still made genuinely first, through genuinely shared code. **Rejected: a special-cased "just check
the node id, skip the rest" branch**, which is exactly the per-stage-kind design this exists to
retire, and which would stop being true the moment diagram rendering ever moved server-side.

The client gets more out of the generic reference than the server can: in the browser that minted
the comment, and in a later one as long as mermaid's internal SVG structure for that source has not
shifted, it addresses the clicked node directly against the live SVG. That is used for POSITIONING
only, and trusted only if the element it lands on also carries the stored node id — a cheap
cross-check, so a shifted structure or a different CDN version can never silently position a pin on
the wrong node, falling back to an id scan when it fails. Positioning is display-only either way;
the resolved-or-lost verdict a pin's style is drawn from always comes from the server, which is what
lets an offline archive show every pin correctly with no SVG to position against.

### Entry 30 — the numeral on the tab mark

**Why the tile is `DARK['--warning']` in both themes.** A favicon gets no CSS and no useful
`prefers-color-scheme`, so one tile has to serve a light tab strip and a dark one, and the choice is
constrained to a hue that survives both. `--accent`'s two theme values sit too far apart for that:
whichever one is picked is wrong on the other strip. `--warning` is the one hue this palette carries
at nearly the same value in either theme, so it is the only candidate that does not need a fork the
format cannot express. The cost is accepted knowingly and recorded on the entry: the brand now
permanently shares a hue with a state colour.

**Why the inverted tile was dropped, which is what the numeral replaces.** Signalling pending by
inverting that tile spends the brand to carry the state, so the tab stops looking like claude-board
at exactly the moment the reviewer is scanning the strip for it — the signal destroys its own
landmark. It is also flat: a reviewer owing three answers sees the same pip as one owing one, so the
mark says "something" and can never say "how much". Ink mass on an unchanged tile answers both,
keeping the landmark and carrying a magnitude.

**Why the numeral is canvas `fillText`, not a second SVG data URI.** SVG favicons resolve fonts
inconsistently across browsers, and a dropped family there renders a blank amber tile — which reads
as *idle*, the worst failure this mark could have, because it lies in the safe-looking direction.
Canvas fails loudly instead: it returns null, there is nothing to swap in, and the tab keeps the
mark it had. The size steps are optical rather than a linear scale, because the digit has to survive
the 16px downsample.

### Entry 32 — a rendered page as a snapshotted stage

**Why the linked-out page was not left alone.** The status quo was not neutral, it was a tax being
paid in prose. `/visualize`, `/explain`, `/gamify` and the nightly digest all posted a *link* to a
45-80 KB page rather than showing it, and up to a quarter of each skill's own text existed to
justify that indirection — to explain to the reader why the artifact they asked for arrived as a URL
and what to do with it. Four callers were each carrying an apology for the same missing capability,
which is the signal that the capability belongs one level down rather than in every caller. Showing
the bytes deletes all four apologies at once.

**Why the daemon's own origin is never framed.** Framing an agent-authored document at the daemon's
own origin was never on the table: a same-origin frame could script the board page and answer its
own questions, which is strictly worse than the link it replaces, where COOP severs the opener. The
served-file route was therefore never framed either — it answered with `X-Frame-Options: DENY` and
`frame-ancestors 'none'` for as long as it existed, before entry 38 deleted it.

### Entry 40 — the condense is a ramp, not a boolean

**Why no control on the header.** The header has to be minimizable, and a control is the obvious way
to do it, but every treatment that puts one there spends a click and a piece of permanent chrome on
a state the reader's own scrolling already announces. Scroll position is a signal already being
generated for free and read by nobody; a button asks the reader to restate it deliberately. So the
scroll drives the condense and the header gains no control at all.

**Why every board condenses, not only a page board.** Condensing was first worth having for a page
board, where an artifact wants the viewport, and it would have been cheaper to scope it there. But a
page board condensing while an ordinary board sat static reads as two designs in one product: the
same chrome behaving by two rules depending on what the caller happened to pass. Uniform behaviour
costs an ordinary board a reserved flow box for the header, which is the price recorded on the
entry, and buys one header rather than two.

**Why the ramp replaced a boolean flipped at 24px.** A reader resting on that offset flapped the
entire header on and off, and it could not be animated away: `left: 0; right: 0` to `left: 50%;
right: auto` has no interpolable midpoint, so the flip was instant in both directions. **Rejected:
widening the dead zone**, which moves the boundary rather than removing it. A 0-to-1 progress
removes the boundary by construction, and has the side benefit that the pill forms under the
reader's own finger, which is the feedback the instant flip used to get from the scroll itself. A
percentage inset interpolates where an intrinsic width does not, which is why the pill's half-width
is a measurement of the surviving controls rather than a fact about the content.

### Entry 42 — rounds are the board's pages

**What broke.** Rounds stacked vertically down one board, which survives a round of three short
questions and fails outright on a round that fills the viewport: reaching the current round means
scrolling past every settled one, and two rounds on screen at once means neither has the room it
was designed for. Paging is what a vertical stack degrades into once a single round is page-sized.

**Why per-artifact boards and full round titles were dropped.** Giving each artifact its own board
was tried first. It multiplies a thread's boards in the index, and it makes one `ask` call mean "a
round here" or "a whole new board" depending on what the caller happened to include. The pager's
first version printed each round's full title; titles are
agent-supplied and `ask` requires one on every call, so a five-round thread rendered five ellipsed
stubs that named nothing, and the clipping also swallowed the owed dot, which sits past the
truncated text. Naming one round well beat naming five badly.

### Entry 45 — an awaited page board, declared by the caller

Both flagless alternatives were worse. Waiting on every page board strands `/visualize` mid-turn; a
separate collect tool spends a second call saying what the first one meant. Inference in entry 33's
style is closed off because "does this caller want to hear back" is not a fact about shape.

### Entry 50 — a wait that dies is recorded on the round

**What the stamped-at-mint flag cost.** Entry 45's `awaited` was written when the round was minted
and never unstamped, so the flag recorded an intention rather than a state, and a round whose
deadline had passed still read as awaited everywhere. Three separate symptoms came out of that one
missing write: the round kept counting toward the index badge, so the badge demanded an answer for a
wait nobody was holding; it went on swallowing its own comments instead of letting them ride the
thread's next packet; and a re-post resumed it against a deadline already in the past, which is a
wait that can never end well. Three bugs, one cause — which is the argument for fixing the fact
rather than the three readers of it.

**Why not a clock in every reader.** Asking "is this round still awaited" at each of the five
surfaces leaves the round re-waitable, which the stored-fact approach gives up. But it makes "is
anyone listening" a question five pieces of code answer independently — exactly the drift entry 45's
"one property behind three surfaces" exists to prevent, and the same three symptoms above would
return the moment one of the five drifted. Clearing the flag at `readBoard`, the one choke point
every reader already passes through, makes all five correct without any of them knowing.

### Entry 124: the home page is Missions

**The page, top to bottom.** One top bar, then the view under it. The bar is the board page's own
header, `.board-head` in the board page's `.board-shell`, rendered by one function for both home
views: the mark at 30px linking home, the 20px title, the Missions and Boards tabs beside it, and
on the right the timer, Comment and theme controls. The Boards tab carries the daemon's one waiting
total, the same number on either view at the same moment. Under it, Missions draws a row of counts
and then five columns, Needs you, Working, Waiting, Stalled and Released, as a grid of columns at
least 250px wide that wraps on a narrow window. A card is a grey line with its key and phase and
its age at the right, the title, the summary, what it waits on and what comes next, and a foot of
small chips (Queued under Waiting, a tab card's tags, its PRs with a mark for their state) with
Fire or Merge while asked. The whole card opens its board, the round asking or else the latest.
Stop sits over the age while a session is live, shown on the card's hover or keyboard focus,
while its question is open, after Keep or Escape hands it the focus, and always on a screen with
no hover, asking once before it sends, or sending at once on a Cmd-click.
Boards is the list of Threads with its filter, the home page before Missions took `/`, now at the
bar's full width (ADR 137): one panel at every width, a 38px line per board (its dot, the title
cut with an ellipsis, the rounds-left chip, then folder, round count, last update and thread id as
fixed columns, the folder and thread id hidden under 760px), the whole line the link. The lines
are grouped "Waiting on you", the boards with a round waiting on the person (the dot's own fact),
over "Earlier", each headed by its count and left out while empty, and a board moves group on the
next repaint. Rejected: one ungrouped dense list by time, the card-per-line list from before
Missions, and a grid of cards from 1440px.

**A mission card is as tall as its text, in Linear's density** (ADR 137). A card is padded 10 by
12 with 8px corners and no shadow, its title 13px medium, its grey key line 12px, showing the phase
alone when the title is the key. It clamps its long fields: the title and the summary to 2 lines,
waiting on to 2, next to 1, each ending in an ellipsis. One Show the rest fold per card shows every
field whole; it takes no room while nothing is cut, and stays open across repaints. The whole card
is the link: its title is a real `<a href>` whose box stretches over the card under its chips,
buttons, fold and forms, so a click, Enter, a middle-click, a Cmd-click and the link's own menu all
work as on any link, and with Comment on a press, the middle one included, opens the card's note
instead. The key line's age, login and folder sit above the link so a hover reaches their tooltips,
and a press on one still opens the board. It carries no Open
board button; Fire and Merge stay shown, since they are calls rather than navigation, and Stop
waits for hover or focus. An earlier build made the article itself a `role="link"` around its
buttons, which had none of a link's middle-click, menu or hover address. A tab
card with several rounds waiting opens the first, the rest reached through Boards. Rejected:
the earlier card with only its forced height dropped (it kept the roomy type and padding the
person called out), Open board and Stop always shown on every card, and relying on the agents that
write a mission to keep `waitingOn` and `next` short, which no card can enforce.

**Why columns.** Three layouts were mocked. A needs-you-first list puts the one urgent thing on
top and buries the rest in one undifferentiated scroll, so "what is working" has no place to be
read at a glance. A card per mission carrying its phase track (grill, direct, landing) answers
"how far along" well and "what needs me" badly, since the urgent cards sit wherever their work
happens to be. Columns by state answer the question the page is opened for, and the phase still
rides on each card.

**Why the boards moved out rather than down.** The first cut put the boards list below the missions
on one page. Boards are read on a different errand, finding a past round, and below a column grid
that grows with the work they drift out of reach; and the list was capped at 900px while a board
page runs to 2560px, so the two never lined up. A tab each, under one bar, keeps both at one width.

**Why the board page's own header.** A home bar of its own would be a second header for the eye to
learn and a second set of edges, so going from a card to its board would move the logo, the timer
and the theme control. Rendering both home views through the same header, at the same shell, means
switching tabs or opening a board moves nothing in the bar. Two measured traps sat under "moves
nothing": the restyled scrollbar takes 11px even under overlay scrollbars, where the gutter rule
reserves nothing on a page that does not scroll, so a short view and a long one differed by 11px
until the home views scrolled their root always; and the first width read could predate the
root's scrollbar (QUIRKS.md has both).

### Entry 102 — one copy of the mechanism

**Why the description was fixed before anything else.** The manual already carried the routing rule
— a lone follow-up and a yes/no stay in the terminal, everything wider goes to the board — and it
was never reached, because the description that gates it triggered on *intent*: "when posting
questions to the board", "when a skill names the board". Both are downstream of a decision already
taken. Nothing fired on the situation that matters, an agent about to fan four questions into a
terminal having never thought about the board, so the rule that would have redirected it sat inside
a file only opened after the redirect. Rewriting the description to trigger on the situation costs
one line in a file this repo owns, and reaches callers written later, callers installed from
someone else's marketplace, and plain chat with no caller at all — none of which any migration
reaches.

**Why the migration is offered rather than run.** Rejected: sweeping the reader's `~/.claude` at
install time. It edits files this project does not own, on a machine where `~/.claude` is often not
version-controlled, and it re-manufactures entry 11's failure at N files the moment one sweep
writes mechanism instead of a pointer. The `INSTALL.md` procedure keeps the capability and moves
every irreversible part behind the reader: read-only inventory, a round of questions with
recommended answers, batched edits with the diffs shown. Four exclusions carry the cost that makes
this fragile rather than merely tedious — the installed manual and anything under
`~/.claude/plugins/` are both overwritten without a word by the next update, and an unattended
caller routed to a board that refuses headless sessions trades a working run for a fallback path.

**Why the example caller is not installed.** Rejected: shipping `grill-example` from
`plugin-skills/`, where the plugin already delivers `/claude-board:install`. A model-invoked skill
there loads its description into every plugin user's context whether or not they want an interview
skill, and it turns the plugin from delivery-plus-install into an opinion about how to run a design
review. Copied by hand, it costs nothing until someone wants it. Also rejected: no example at all,
leaving the description to carry the whole load — the description says *that* a caller should reach
the board, and nothing shows what a caller that defers its mechanism actually looks like.

## Out of Scope

- Live revision of the artifact after feedback. Lavish edits the page in place; we re-render from
  the store.
- Anything multi-user or remote. Authentication is not in this list: reads are gated, per
  `SECURITY.md`.
- Server-side mermaid rendering, and therefore fully offline diagrams.
- Converting `/diagram`, which emits markdown rather than a page.
- Migrating the other commands, and whether `/triage` renders its own board or only consumes
  `/audit`'s packet.
- Rebuilding `/triage`'s applier around the answer packet; it consumes the packet and keeps its
  current behaviour.
- Coordinate-based comment pins; anchors are elements or blocks.
- Chrome-automated checks of the interactive layer as part of the standing suite.
- Redesigning the answer widgets or the round model.
- Editing or deleting a **sent** comment, or any affordance implying either is possible.
- Capping markdown or html blocks the way code blocks are capped.
- Fixing the pre-existing `.html-stage` pin drift on inner scroll and resize-drag. (Both went
  later: a stage's scroll re-asks its pin positions, and ADR 119 replaced the drag with a stage
  that fits its content.)
- A high-contrast or forced-colors variant, a user-customizable accent, a print stylesheet, and
  per-board theme — theme is a reader preference, never a property of a posted board.
- Loopback host canonicalization.

## What worked, and what did not

Five dead features shipped green on this project. Every one is the same shape: **a check that
asserts what the code should produce, instead of reading what it did produce, is an assumption
wearing a test's authority.** The instances, each written up in `QUIRKS.md`: string assertions over
the exported client script (a listener exists ≠ a listener fires); a hand-written mermaid mock
emitting unprefixed node ids that real mermaid namespaces; a plist asserted to *contain*
`WatchPaths` entries launchd never acted on; a `getComputedStyle` stand-in reimplementing cascade
precedence in JS rather than parsing the stylesheet; and a brief that listed three anchor-minting
call sites where the code had four.

**Worked: ablation as the standard for believing a check.** Break the behaviour, watch the named
check fail. An ablation a check cannot see is the signal that the check is structural rather than
behavioural.

**Worked: the parity-marker technique**, which binds two copies of the same logic where the served
page's lack of an import graph forces a duplicate to exist. Introduced precisely because one copy
had silently drifted from the other.

**Worked: a real browser as a one-off pass**, and reproducing against the real dependency before
trusting a fix. Every recurrence above was found by opening the page, not by reading code. Record
an external renderer's real output in a fixture rather than mocking it.

**Didn't: a Decision's CSS-only recipe, assumed rather than built.** The cap-plus-drag idiom above
and a literal 1px `IntersectionObserver` band were both written as CSS that reads correctly and
neither works; both were caught building, not designing. The lesson is the cost of the ordering,
not the two mechanisms — a recipe that has never run is a guess with syntax.

**Didn't: assuming what an automated seam can reach.** Drag-to-rank, the notification and full SSE
hydration are checked by opening a board and using it; that check is not automated and should not
pretend to be. Chrome automation was considered and deferred as the standing suite: slowest, most
brittle, and it needs extension permissions wherever it runs.

## Anchoring slice 10 log

Cited from `test/check-stage-isolation.mjs` as "the anchoring slice 10 log" — by that phrase, not
by this file's name, so the grep that finds this section from there is on the phrase.

- **Origin reasoning.** An opaque `srcdoc` origin always serialises as the literal `"null"`, so the
  parent checks that and then re-derives the sending frame from the live DOM rather than trusting a
  claimed identity. Stage-side, `event.source === window.parent` is browser-authored and
  unforgeable.
- **The stage never sends a composed hint** — only raw tag and text, with the parent composing.
  Only the path helpers are embedded into the stage script from `src/anchor.mjs`, the same binding
  the hint composer uses. No third hand-written copy, the trap an earlier slice fell into.
- **The minted ref's root and shape are unchanged**, still an index chain from the iframe's own
  body. Verified that the trailing agent script shifts no index: `ref '2'` and `ref '1.1'` both
  resolve against the stored mock, and a leading `<style>` still hoists correctly. Client and
  server agree because the injected script is always last.
- **The merge failed the first time and was sent back.** Git resolved the overlap with the
  head-hoisting slice textually and silently reintroduced its bug, since this slice rewrote how the
  stage document is built and bypassed the hoist; 60+ failures, reverted. Root causes on the redo
  were a stale inline `window` stub and a stale setup assertion, the srcdoc's body legitimately
  holding `[div, script]` once the agent script is appended after the mock's markup.
- **Ablations on the integration branch, all biting:** restoring `allow-same-origin`, dropping the
  origin check, and removing the meta CSP each fail a named check.

## Loose ends recorded but not acted on

- `resolveComment`'s section-root fallback for html blocks is dead code: every direct child of that
  section is chrome-excluded, verified by driving a click at each one.
- `.round-label` cannot be removed from the chrome-exclusion selector observably, so it may be dead
  config.
- Capping a submit's comment array at roughly 500 entries is a product call rather than a defect.
  Post-fix resolution cost is linear, but nothing stops a 25 MB submit carrying ~100 K tiny
  comments, which would add permanent cost to every future render, push, archive write and packet.
- The session cookie is host-only while the daemon accepts `127.0.0.1`, `::1`, `localhost` and
  `*.localhost` as valid Hosts, so authorizing on one loopback hostname leaves every other one
  refusing. Belongs to whoever owns the read gate (`SECURITY.md`) — the same scheme+host+port
  consequence the theme decisions record for the storage split, never carried across to the
  credential.
