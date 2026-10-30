# CONTEXT — the words this project uses

**Board**: one page a human opens, reads and answers, owned by the session that posted it.
The unit the Boards view lists and the archive keeps. _Avoid_: page, form, review.

**Conversation**: one continuous stretch of Claude context, from a session's start or a `/clear` to
the next `/clear`. Invisible to the daemon and to the shim alike — the agent's own context is the
only place its boundary can be seen, which is why the agent declares it. _Avoid_: session, chat,
context.

**Thread**: the ordered set of boards belonging to one Conversation. A shim process owns one thread
per Conversation it serves, so a `/clear` ends a thread and the next post starts another; a thread's
project directory is bound once and never retargeted. _Avoid_: session, chain.

**Fresh**: of an `ask` call, that the agent has posted no board in this Conversation, so the call
opens a new Thread instead of pushing a Round. Declared, never inferred: nothing but the agent can
see a Conversation end. _Avoid_: new, first, reset.

**Round**: one post into a board, the unit a packet reports on, and the board's unit of layout.
Round 6 does not redeliver rounds 1-5. _Avoid_: turn, batch, post.

**Page**: a Round as the board shows it, one at a time, flipped with the pager. Send covers the
page on screen alone, its check, its count of questions left and the answers it posts; another
unsent page keeps what was typed on it and sends from its own page. _Avoid_: tab, screen, step.

**Awaited**: of a round, that the `ask` call which posted it is still blocked on it, so a submit
reaches a listening agent. The property behind three surfaces — the sendable badge, the Banner,
and the Boards view's per-Thread count of rounds still open — until the round is sent, Abandoned, or its
wait ends.
_Avoid_: waiting (of a round — a round is Awaited, a Board is Waiting), blocking, live, pending,
rounds left, outstanding.

**Waiting**: of a Board, that it holds at least one Awaited round still open, so an agent is
blocked on it. The board-level counterpart of Awaited, and the unit the Status item lists and
counts. Deliberately not Stranded: a board with a tab open in front of it is still Waiting, while
Stranded is the narrower thing a Banner fires on. _Avoid_: unanswered, pending, open, blocked.

**Lapsed**: of a round, that its wait deadline passed before an answer arrived, rather than the
round being answered. A lapsed round is no longer Awaited and is never resumed by a repeat post.
_Avoid_: expired, stale, dead.

**Submitted**: of a round, that the reviewer sent their answers, which is the reader-facing
name for the round state the store calls `sent`. One of the two closed states a reader is told
about by name, Abandoned being the other; Lapsed and never-Awaited rounds are both read-only and
say only that. _Avoid_: sent (internal only), answered, completed, done.

**Abandoned**: of a round, that it was closed with nobody having answered it, because the
conversation that posted it declared itself over — the `fresh` flag on a later `ask`, or a direct
abandon. The second closed state told by name, and terminal in a way Lapsed is not: a lapsed round
sits on a board that can still be posted to, while an abandoned one belongs to a conversation that
has moved to another board. A blocked `ask` on it is released at once and told `abandoned` rather
than left to the wall clock. A Send that arrives after is stored like a Lapsed round's and the round
becomes Submitted; it reaches an agent through `read`, since no thread waits on that board again. _Avoid_: cancelled, dropped, discarded, closed, expired
(that is Lapsed).

**Watcher**: an open board tab holding a live stream to one board. Counted per board and
never per machine: a reviewer sitting on another board's tab is not a watcher of this one.
_Avoid_: client, connection, viewer.

**Remote review**: answering boards from a second Mac's browser while the agent and the daemon
run on another, reached through an SSH tunnel to that Mac's loopback; the daemon itself never
listens beyond loopback. _Avoid_: remote access, LAN mode, network mode.

**Attended**: of a board, that a Watcher has it visible and focused, or had it focused within
the last two minutes, so a tab left open behind the terminal still counts as watched for a
short while. Reported by the tab, since a live stream proves only that a tab exists.
_Avoid_: active, foreground, in view.

**Suppressed**: of a fresh board's auto-open, skipped because some board — any board, any
project — already has a Watcher, so a new tab would steal focus from a reviewer already on
one. The Banner announces the board instead. _Avoid_: deferred (collides with deferred
answers), skipped, blocked.

**Stranded**: of a round, that it is not yet Announced while its board is not Attended, and
it is either Awaited or the first round of a Suppressed board, so nothing on screen is
telling the reviewer it is there. Covers the board with no tab and the board buried behind
three windows alike, and it is what a Banner fires on. _Avoid_: orphaned, unattended, unseen.

**Announced**: of a round, that a Banner has been raised for it. Permanent for the life of the
round, with one exception: amending the round while its board is unattended un-announces it, so
it may be Announced again for the content that changed (amending it while the board is Attended
does not). Short of that, returning to the board takes the Banner off the screen without
un-announcing the round, so an unamended round is Announced at most once and no glance can buy it
a second Banner. _Avoid_: notified, alerted, signalled.

**Banner**: the native macOS notification the daemon raises for a Stranded round, naming the
project and carrying its board so that clicking it lands there. The only notification this
product raises *about a round*; the Missions notification is about missions, and the Notice below
is in-page and is about an interaction, not a round. _Avoid_: alert, toast, notification
(unqualified) — also collides with macOS's own banner/alert distinction.

**Banner level**: the four-step setting saying when a Stranded round earns its Banner — Off,
on when no board is Attended, on when this board is not Attended (the default, and today's
rule), always on. Strictly monotone, each step bannering in more cases than the last, and it
replaces the binary notifyRounds toggle; Off alone is absolute (ADR 106), and silences the
Missions notification too, which every On level lets through. _Avoid_:
notification level, alert mode, notifyRounds (the superseded key).

**Notice**: the in-page message the board raises when a gesture cannot land, saying why —
today, that Comment mode is on and so answers are locked. Transient and self-dismissing,
never standing, and never more than one at a time. _Avoid_: toast, banner (the macOS one),
hint (names the per-option text this product deleted), cue (ADR 20 spends it on the Banner's
naming).

**Block**: the atomic piece of a board — markdown, code, mermaid, html, compare, or question.
Everything a board shows is one, drawn as a titled card. _Avoid_: section, element, card (the
look, not the thing).

**Card fields**: the optional title, status chip, one-line summary and folded details any Block
may carry, a question only the details; absent when not sent, so a stored board is unchanged.
_Avoid_: metadata, header fields.

**Card head**: the row every Block's card opens with, its title (the Card fields' title, a
question's prompt, or a markdown block's opening heading) and its status chip at the right edge.
Chrome, never a comment target, and never a type caption. _Avoid_: caption, kicker, label.

**Content block**: a block that renders material of its own — `markdown`, `code`, `mermaid`,
`html`. Everything a reviewer reads sits in one. _Avoid_: artifact block, context block
(`context` is a field on a question, not a kind).

**Wrapper block**: a block that renders no content of its own, only structure around blocks
that do — `question` and `compare`. Chrome as far as commenting goes: never Commentable itself,
though a rendered block nested inside it still is. _Avoid_: container, layout block.

**Explainer**: the one to three sentences a question carries under its prompt, on the card's full
row above the options and the context, saying what is being decided and what it changes — markdown by value in the question's
`explainer` field, the agent's words, never the reviewer's. _Avoid_: description (an option's),
context (what the reviewer looks up), note (the reviewer's).

**Context**: what a question carries beside its options for the reviewer to look up — the
section under discussion, the code it constrains, a diagram — rendered as one panel of plain
prose, items in posted order, no kind label per item, and a Card head only on an item with a
title or a chip. _Avoid_: context block (see
Content block), attachment, sidebar.

**Fold**: a prose item clipped at about a dozen lines under a fade, opened in place by Show
the rest — per item, wherever the item sits, decided by a count of its source. A Stage outside a
page board or a variant option folds too, past 600px: it scrolls inside at that height, and
Show full height under the frame opens it in place. A code
excerpt keeps its own scroll box, and a diagram does not fold. _Avoid_: collapse, truncate, clamp.

**Commentable**: carrying the comment control and the click-to-anchor gesture — only the
rendered content kinds, `mermaid` and `html`, wherever they appear; `markdown` and `code` never
are. Kind is necessary, not sufficient: the round it sits on has to still be listening, so a page
board nobody is waiting on (ADR.md entry 46) and any round already sent (entry 101) carry none of
it either. _Avoid_: annotatable, pinnable, anchorable.

**Stage**: an `html` block rendered in a sandboxed iframe, carrying its markup either by value
(a hand-mocked UI preview) or by a path-only reference to a rendered file on disk. _Avoid_:
preview, mock, iframe.

**Page board**: a Board whose blocks are one `html` block and nothing else, rendering that
stage at viewport size under the board header instead of in the content column. _Avoid_:
fullpage board, artifact board, embed.

**Band**: the space a board's floating chrome occupies over a Stage — the header at the top, the
pager dock and comment rail at the bottom. _Avoid_: clearance, safe area, gutter, offset, the
96px.

**Pill**: the header once it condenses while scrolling — the mark, the comment toggle, the
theme control and the state label, in that order, on a floating centred band. Also names the
pager dock and the unanswered-count chip elsewhere in this codebase, a collision left
unresolved. _Avoid_: capsule, chip, bar, collapse, minimize, shrink.

**Lens**: the full-viewport surface a stage or a diagram opens into, reached only by its
Pull-out. _Avoid_: overlay, modal, lightbox.

**Pull-out**: the always-visible control in the top-right corner of a Stage or a diagram, the
one way into the Lens. _Avoid_: expand pill, expand button, pop-out, corner button.

**Packet**: what `ask` returns when a round closes — the round's answers, its comments, and a
status. _Avoid_: response, result, reply.

**Anchor**: the address a comment is attached to, naming a block and optionally an element
inside it — a node in a stage's markup or a node in a diagram, the only two things that are
Commentable. _Avoid_: pin, target, selector.

**Tray**: the floating surface an awaited page board shows for commenting — the queued
comments, the composer and the send controls in one panel over the Stage. _Avoid_: panel
(generic), drawer, dock (the pager's).

**Reference**: a pointer a block carries instead of its content, resolved and snapshotted at
post time. The agent supplies references and question text; it never drafts the content being
rendered. _Avoid_: link, include, embed.

**Refused**: of a post or an amend, that the daemon answered it 400 and stored nothing, rendered nothing and pushed nothing, so the caller re-posts; a reference that fails to resolve and a diagram that does not parse each refuse the whole post, one message per failure. _Avoid_: rejected, failed, errored, dropped.

**Fallback**: the non-board path a command takes when the board is unreachable — always
announced, never silent, and degraded rather than equivalent: it promises a path exists, not
the same experience. _Avoid_: offline mode, graceful degradation.

**Interval**: one timed stretch the timer is counting down, either a **work interval** or a
**break interval**. The unit the notification fires at the end of. _Avoid_: pomodoro, session,
sprint, block.

**Cycle**: the run of `N` work intervals whose last break is a long one. Resets after each long
break and at each Rollover. _Avoid_: round (that is a board's unit), set, series.

**Pomodoro day**: the span the Cycle is counted over — 05:00 local to 05:00 local, not midnight
to midnight, so a session running past midnight still belongs to the day it started on.
_Avoid_: day, date, calendar day.

**Rollover**: the Pomodoro day changing, which ends the whole loop — Timer gone, Cycle back to
zero. Observed lazily, by whichever read or write next touches the document, never fired by a
scheduler. _Avoid_: reset (that is the user's control), nightly reset, cron, midnight reset.

**Unattended session**: a Claude Code session nobody is sitting in front of — a cron keepalive,
anything scripted. It declares itself, since nothing in a session's own shape reveals it, and
the session-start hook then leaves the Timer alone. _Avoid_: headless, print mode, bot, `-p`.

**Timer**: the daemon's single global clock — one per machine, never per Thread. It is running,
paused, or absent; there is no third timer anywhere. _Avoid_: pomodoro, countdown, clock.

**Status item**: the macOS menu bar surface — the Timer's phase, and its remaining time only while
it is running. A pure client: it holds no Timer, no settings and no notification of its own, and it
is a second process of the same bundle, never a second app. _Avoid_: menu bar app, menulet, tray
icon, systray.

**Popover**: the panel a click on the Status item opens — the Timer's phase and controls, the
Boards waiting for an answer, one row counting the Missions that need you and those working
(it opens the Missions view, and is absent while both are zero), and a way through to
settings. It carries no state of its own: every row is a snapshot of the daemon taken when it
opened. _Avoid_: menu, dropdown, panel, window.

**Cue**: the sound a boundary's notification carries, chosen per phase — the name of one of the
sounds macOS ships, or `None`. It rides on the notification rather than being played beside it,
so anything that silences the notification silences the cue too. _Avoid_: sound, alert, chime,
notification sound.

**Forward**: the control that ends the current interval now — the boundary happening early, taking
the exact advance rule a natural end takes (credit and long-break cadence intact), silently. A
forward preserves paused, landing at the start of the next phase with that phase's full duration
still to run (ADR 82); against no timer it is a no-op. _Avoid_: skip, next, advance.

**Restart**: the control that starts the current interval over — a fresh full-length interval read
from the current settings, phase and cycle untouched. Same edge rules as Forward: silent, preserves
paused, no-op when idle. _Avoid_: reset (that ends the whole loop), redo, replay.

**Master switch**: the one setting that makes the whole pomodoro feature optional, off by default
(ADR 105). On, the loop and its surfaces exist; off, none of them render and the Timer is gone —
off is absence, never a dimmed surface, and flipping it off ends the loop the way a Rollover does.
_Avoid_: enable flag, feature flag, kill switch, toggle (every checkbox is one).

**Board glyph**: the Status item's off-state mark, holding the item's place while the Master switch
is off (ADR 103) — the brand mark's square and rows redrawn as line art, square like the 32 × 32
favicon it echoes, never a portrait rect. _Avoid_: off icon, placeholder icon, app icon.

## Missions

**Mission**: one piece of work across all its sessions, its grill, direct and landing alike,
keyed by a short name such as a spec's descriptor (`FRONT_AGENT`). Its record holds work names,
phases, links and closing summaries, never case content, and is written by whichever agent works
on it. _Avoid_: task, job, ticket, project, session (a Mission outlives several).

**Ledger**: every Mission the board holds, beside its boards and read live by the Missions view
and the Master Chief. The board's status half, as boards are its decision half. _Avoid_:
tracker, status board, queue.

**Master Chief**: the one long-lived agent session a person talks to instead of each session:
it launches the sessions, reads the Ledger, and relays Orders and answers to them. It lives
outside this repo; the board knows it only by the calls it makes. _Avoid_: front agent,
orchestrator, lead.

**Background session**: a session the Master Chief started with nobody at its terminal, declared
by `CLAUDE_BOARD_CLIENT=background`: it posts boards and opens no tab, since its human answers on
the board. Unlike an Unattended session, which must not post at all. _Avoid_: headless (that is
the refusal), detached, bot.

**Missions view**: the board's home page (`/`), every Mission in the column of its Mission state,
each a card with its summary, PRs and buttons that opens its board. _Avoid_: dashboard, overview, index
(the old name of the page now at `/boards`).

**Boards view**: the list of Threads with its filter, at `/boards`; the home page until the
Missions view took `/`. One line per board, grouped "Waiting on you" (its Waiting boards) over
"Earlier" (every other), each group with its count and left out while empty; the whole line opens
the board. _Avoid_: index, index page.

**Top bar**: the board page's own header, shared by the Missions and Boards views with one tab
for each; switching tabs moves nothing in it. _Avoid_: nav bar, header (unqualified: a board
page has its own).

**Mission card**: a Mission on the Missions view, as tall as its text: its long fields clamp to a
line or two, whole behind one Show the rest fold. The whole card is the link to its board (its
title's link covers it), the round waiting on the person or else the latest; its Stop shows on
hover, keyboard focus or while its question is open, and always on a screen with no hover, while
a Fire or Merge it offers stays shown. _Avoid_: tile, row.

**Mission state**: the column a Mission shows in, derived on every read: needs you, working,
waiting, stalled or released. Between merge and Released a Mission is working, or needs you
while a release step waits on the person. Needs you is any linked board whose newest round is
still open and asks the person a question or was posted Awaited, a Lapsed one included; waiting is the Mission waiting on
something else (a check, another PR, a Queued launch). _Avoid_: status (collides with the
Packet's), phase (grill, direct or landing), column, landed (the name before Released).

**Released**: of a Mission, that every release step after its merge is walked: each deploy,
infra apply, one-time script, secret, switch or production check that puts the change in
production or proves it there. A Mission with none is Released at its merge. _Avoid_: landed
(that is the merge), shipped, done, deployed.

**Live**: of a Mission's session, that it holds the Mission: bound or reserved, its Mission has
not recorded its end, and its process is not gone. Only one session is Live per Mission, and only
a Live one has a Stop. _Avoid_: alive, running, active, open.

**Stalled**: of a Mission, that its session's process is gone, no process bound its launch
within five minutes, or it has been working and silent fifteen minutes. A silent session whose process
lives is Stalled and still Live. _Avoid_: dead, hung, crashed, stale.

**Queued**: of a Mission, that its launch waits for a slot, past six sessions working or twelve
alive; shown under waiting with its tag, launched by the Master Chief when one frees. _Avoid_:
pending, backlog, deferred.

**Action**: the answer a `single` question names in its `action` field, `fire` or `merge`, its
yes being option 0. While its round is its board's newest and waits on an answer, the Mission's
card offers that yes as a button, and a click is that round's Send. _Avoid_: shortcut, quick answer, command.

**Order**: a Stop or a comment sent from a Mission's card, for the Master Chief to carry to the
Live session and mark relayed. A request, never a signal: the board ends no process. _Avoid_:
command, signal, message, kill.

**Relayed**: of a round, answered by the Master Chief on the person's own words, carried verbatim
with the answer, rather than by a Send on the page. _Avoid_: forwarded, proxied, approved.

**Tab card**: a card on the Missions view for an agent session no Mission launched, a tab the
person started by hand or a background job, reported by the Session watcher and held only in the
daemon's memory: its name shows while it runs and is never stored. In Needs you while a round it
posted waits on the person or it is blocked, else Working while busy, else Waiting with "your
turn". It is a Mission card in shape, as tall as its text and its long fields cut short
under the same fold; while rounds it posted wait on the person, the whole card opens the first. It takes Orders like a Mission's card and counts toward no launch cap. A session a Mission
holds is that Mission's card, never a Tab card. _Avoid_: session card, tab (unqualified: a
browser tab), orphan, hand mission.

**Session watcher**: the process outside the board that posts the running sessions to the daemon
every interval; the board reads no agent's folder itself. Two missed intervals read it down, and
the Missions view says so. _Avoid_: scanner, poller, sessions daemon.

**Missions notification**: the one native notification for a batch of Missions turning needs you,
stalled or released within a minute, naming the work or counting it. Silent at the daemon's start,
and silenced by the Banner level's Off. _Avoid_: Banner (that is a round's), mission alert.
