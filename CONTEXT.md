# CONTEXT — the words this project uses

**Board**: one page a human opens, reads and answers, owned by the session that posted it.
The unit the index lists and the archive keeps. _Avoid_: page, form, review.

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

**Awaited**: of a round, that the `ask` call which posted it is still blocked on it, so a submit
reaches a listening agent. The property behind three surfaces — the sendable badge, the Banner,
and the index's per-Thread count of rounds still open — until the round is sent, Abandoned, or its
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
than left to the wall clock, and a Send that arrives after is refused by name rather than as "already
submitted" — nobody submitted anything. _Avoid_: cancelled, dropped, discarded, closed, expired
(that is Lapsed).

**Watcher**: an open board tab holding a live stream to one board. Counted per board and
never per machine: a reviewer sitting on another board's tab is not a watcher of this one.
_Avoid_: client, connection, viewer.

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
product raises *about a round*; the Notice below is in-page and is about an interaction, not
a round. _Avoid_: alert, toast, notification (unqualified) — also collides with macOS's own
banner/alert distinction.

**Notice**: the in-page message the board raises when a gesture cannot land, saying why —
today, that Comment mode is on and so answers are locked. Transient and self-dismissing,
never standing, and never more than one at a time. _Avoid_: toast, banner (the macOS one),
hint (names the per-option text this product deleted), cue (ADR 20 spends it on the Banner's
naming).

**Block**: the atomic piece of a board — markdown, code, mermaid, html, compare, or question.
Everything a board shows is one. _Avoid_: card, section, element.

**Content block**: a block that renders material of its own — `markdown`, `code`, `mermaid`,
`html`. Everything a reviewer reads sits in one. _Avoid_: artifact block, context block
(`context` is a field on a question, not a kind).

**Wrapper block**: a block that renders no content of its own, only structure around blocks
that do — `question` and `compare`. Chrome as far as commenting goes: never Commentable itself,
though a rendered block nested inside it still is. _Avoid_: container, layout block.

**Commentable**: carrying the comment control and the click-to-anchor gesture — only the
rendered content kinds, `mermaid` and `html`, wherever they appear; `markdown` and `code` never
are. _Avoid_: annotatable, pinnable, anchorable.

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

**Lens**: the full-viewport surface a stage or a diagram opens into, reached only by its own
expand control. _Avoid_: overlay, modal, lightbox.

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
Boards waiting for an answer, and a way through to settings. It carries no state of its own: every
row is a snapshot of the daemon taken when it opened. _Avoid_: menu, dropdown, panel, window.

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
