# Changelog

## Unreleased

- **Download round**: a round's page has a Download round button at the right end of the
  round's chip line, or in the top strip when the round is one mock drawn full page, where it stays
  in view as the mock scrolls. On a question round it saves that one round as a single HTML file
  that opens offline: the board's title, the round's number and date, a table of each question with
  its pick and note, then the round in full, with every option and the pick marked, diagrams as
  pictures, each mock a still copy at full height with its scripts left out, comments under what
  they point at and images inside the file. The browser's Print makes a PDF of it. A round not yet
  sent saves too: its file opens on a Not sent line and marks each pick so far as unsent. Pull-out,
  the full-window view of one mock or diagram, has a Download of its own that saves that one alone.
  A board opened from Finder offers none of these.
- **A saved mock is the page itself (ADR 154)**: Download on a mock's Pull-out, and Download round
  on a round that is one mock drawn full page, save the mock as its own working page: its scripts
  run, its diagrams draw, its contents list fills and its controls work, opened from disk with no
  connection. A mock that draws diagrams gets the board's diagram library written into the file,
  about 3.5 MB, so it asks the web for nothing; a library a mock names by an `https:` address
  stays a web address. The file runs the mock's scripts wherever it is opened, so treat one as you
  would the session that made it; its own policy keeps those scripts from loading any other file
  off your disk. It carries none of the comments made on the mock. When a mock cannot be saved
  (the board is not running to hand over the diagram library, the mock has not loaded, or the
  page has been open since before the board was updated), the button says so under itself and
  nothing is saved.
- **A mission's next session picks up the questions the last one left (ADR 151, 153)**: when a session
  joins a mission in place of the one before it, or takes the mission over, each round that
  session left unanswered goes back to waiting in place, whether it was closed at a `/clear` or
  the session's end, had timed out, or was still waiting at the takeover. It keeps its round
  number and everything the board holds for it, gets a fresh 40-minute clock, and shows under
  Waiting on you again; a tab you still have open on it takes answers again with no reload. Your
  Send reaches the new session, which is told of each reopened round when it joins. A round you
  already sent stays read-only, and rounds of earlier sessions stay closed. A session that left
  the mission on purpose (`/mission off`) with nobody taking over hands its unanswered rounds on
  the same way, to the next session that joins, also when a session in between started on the
  mission and ended or left before it joined. A round nobody answers reopens again for
  the session after, until you send it or a session declines it: `mission close` closes one
  reopened round whose question no longer stands, for good. Before, such a round stayed
  read-only and a late Send reached a session only when it thought to read the board.
- **A handed-over question keeps its mission under Needs you (ADR 155)**: a mission's card stays
  under Needs you while a round reopened for its next session still waits on your answer, also
  after that session posts something newer. Before, the session's next round took the card back
  to Working and the question showed under Waiting on you on the Boards page alone. The card
  clears when you send the round or the session closes it. An older round that merely timed out
  stays off the card, and the card's Fire and Merge buttons still come from each session's
  newest round only.
- **The top strip lets clicks through**: a click on the empty part of a board's top strip now
  lands on the page under it, so the buttons of a mock's or diagram's full-size view take their
  click where the strip floats over them. The strip's title and controls take theirs as before.
- **The top strip leaves for a mock's own full-size view**: while a mock drawn full page shows a
  full-size view of its own, the top strip is hidden so it does not cover that view's buttons,
  and it is back when the view closes.
- **An image that fails to load is named**: a pasted or dropped image the board cannot load now
  shows a line naming the file, and the other images of that paste are kept.
- **Send and Discuss while pasted images load**: the first of the two you press is the one that
  acts, once the images have loaded; the other button is off until then.
- **A screen run's sign-in can be a link**: a session can now mint a one-time link that, clicked,
  opens the sign-in browser on the Mac running the board; you still sign in there. It logs nobody
  into the board, is good until used or until the board restarts, and lives only in memory. A used
  link says so and points you at the typed command, which still works. The reasoning against the
  30-second board link is in SECURITY.md.
- **Ten sessions can work at once and fourteen be alive, up from six and twelve (ADR 148, 149)**: a
  mission launch now queues past ten sessions working or fourteen alive. A mission held by a tab you
  run yourself no longer takes a slot: the limits count the background sessions alone. While the
  session watcher is down every mission's session counts, as before.
- **Answering a waiting round restarts its 40-minute wait (ADR 145)**: each answer pick, typed
  note or saved comment on a round a session is waiting on now moves that round's deadline to a
  full 40 minutes from that moment, both on the page's own countdown and in the session's wait. A
  round that draws none of that activity still ends 40 minutes after it was posted, as before. A
  session already waiting when the update ships keeps its original fixed 40-minute deadline,
  unaffected.
- **A late answer wakes the session that asked**: when a Claude Code session's wait on a round
  ends with nobody having answered, the `timeout` result now names an answer watch, a command the
  session runs as a background call (`node <clone>/bin/watch.mjs --board <id> --round <n>`). For up
  to 24 hours it checks the board every 30 seconds, and once the round is sent it wakes the session
  with that round's answers and comments, to act on once: no later round's result carries them
  again, and a round a later result already carried comes back marked `delivered: true`. A late
  pick that differs from something the session already built, fired or merged comes to you as a
  question; nothing built is undone. A Codex or OpenCode session gets no watch and says its wait
  ended, as before. Before, a late Send reached the session only with its next round's result, or
  when it thought to read the board.
- **A retired mission stops asking**: a mission carrying a retired time never shows under Needs
  you or Stalled again, whatever its last rounds or its last "waiting on" say. While it still has
  an open PR (one neither merged nor closed) or a release step waiting, its card sits under
  Waiting with a Retired tag; once it has neither it leaves the Missions page, the Master Chief's
  list and the missions watch's full list, though reading it by key still answers. Its record is still deleted 30 days after it
  retired. Before, a retired mission whose session had gone read Stalled, or Needs you while an
  old round stayed open, and the Master Chief raised it as a live ask.
- **A leftover background job stops needing you**: a blocked background job with no process
  whose session belonged only to missions that are now released, or that another session now
  holds, no longer shows a Needs you card. Every other blocked job keeps its card, as before.
- **A compare card's Comment buttons sit on its BEFORE and AFTER rows**: a side holding a stage
  or a diagram now opens one row with its label, then its title if it has one, its Comment button
  and its chip, and its picture starts under that row, level with the other side's. Before, the
  Comment button (and a title) took a row of their own between the label and the picture. A title
  long enough to wrap still makes its side's row taller.

- **Board pages open at once however many tabs are open**: every board tab and index tab of a
  browser now shares one connection to the daemon through a SharedWorker, where each tab held its
  own. Chrome allows six connections per host over plain HTTP, so through an SSH tunnel the
  seventh page used to wait for a slot. A closed tab still stops counting as watching its board at
  once, and the nobody-is-watching banner still fires after the grace. A tab already open on the
  old page keeps its own stream until reloaded.

- **An oversized post gets a 413, not a dropped connection**: a post over the 25,000,000-byte
  limit, up to 100,000,000 bytes, is now read through, stored nowhere, and answered HTTP 413
  naming the size it read and the byte limit; the next post on the same connection is served
  normally. The MCP shim relays it as "claude-board daemon rejected this board (HTTP 413): ..."
  with no revive command. Past 100,000,000 bytes the daemon still cuts the connection with no
  answer, so the shim refuses such a post before sending it: "ask refused: post is ... bytes, over
  the 25,000,000-byte limit of one post: ...", again with no revive command. Before, the daemon
  dropped the connection mid-upload with no response at all, and the shim told the agent to
  restart a healthy daemon. Every other route answers an oversized body 413 too, naming its size
  and the limit without the board-post advice.
- **A held Pull-out says why nothing opened**: pressing Pull-out on a stage that is still loading
  now shows a note beside the button, "This stage is still loading. Open it full size once it
  shows.", or "This stage did not load. Press again to retry, or reload the page." if the load
  failed; the note stays through a round pushed meanwhile that keeps the stage, and goes away
  once the stage fills in. Before, only the button's tooltip said so, which a sighted reader who
  just clicks never sees.
- **An unstyled mock reads in a dark board**: a stage that sets no color now draws black text,
  blue links and light form controls on its light artboard in both themes (in a dark board its
  text was white on light gray, 1.71:1), and the full-size view shows the artboard where a dark
  board showed a white slab. A stage is told the theme as `data-theme` only; one with a dark
  palette of its own sets `color-scheme: dark` itself.
- **Breaking for a template with its own dark palette: a stage is no longer told a color
  scheme.** The board used to set `color-scheme` on a stage's document beside `data-theme`. It
  now sets `data-theme` and nothing else, and the frame a stage renders in is a light surface
  in both themes. A template that paints a dark palette under `[data-theme="dark"]` and leaves
  any ink to the browser (text with no color, an unstyled link, a native input, a scrollbar)
  now gets the browser's light defaults there: black text and the dark link blue on its own
  dark background, in a stored board the moment it is rendered again. Declare
  `color-scheme: dark` beside the dark palette and the dark defaults come back (measured in
  Chrome on a `#14161a` background: text 18.11:1, link 7.58:1, input text 11.20:1, button text
  5.33:1). `prefers-color-scheme` inside a stage now reads light whatever the board's theme or
  the OS, so key on `data-theme`. The full-size copy a Pull-out opens is told the same
  `data-theme`, so a template draws the same side of its palette there as in its block.
- **A stage fits its mock, and every stage and diagram has a Pull-out**: a stage outside a
  page board now takes its content's height up to 600px instead of a fixed 320px box with a
  drag grip; past 600px it folds, scrolling inside, and Show full height under the frame opens
  it in place (ADR 119). One button in the top-right corner of every stage and diagram opens it
  full size, including a stage inside a question, which had no way in before; the expand pills
  are gone (ADR 120). An in-page link in a stage that shows its whole mock now scrolls the
  board to the target, and one in a stage that scrolls inside moves only the frame, no longer
  the board as well.
- **Remote review**: answer a second Mac's boards from the Mac you sit at. One
  `LocalForward 7392 127.0.0.1:7391` in `~/.ssh/config` carries the remote daemon, which stays
  loopback-only; `npm run remote -- login` logs your browser in over SSH for the cookie's 30
  days, and `npm run remote -- open <url|id>` opens a board the agent printed. The address is
  `localhost:7392`, so the remote login and your own board's login never overwrite each other.
  Setup and limits in INSTALL.md (ADR 118).
- **A label with `<br/>` or `<b>` no longer waves a diagram through**: the door's sandbox was
  missing the DOM method Mermaid's sanitizer calls on HTML in a label, so any such diagram
  failed open unchecked; the sandbox now has it, so these diagrams are checked and a broken
  one is refused like any other.
- **Bad diagrams refuse a post**: alongside the failed-reference refusal, a `mermaid` block or
  `mermaid` fence in `markdown` that does not parse now sends a 400 naming each failed diagram
  and its first error line, so the source is fixed and posted again (ADR 117).
- **Diagrams on an earlier round render**: a mermaid block on a round that is not
  the page on screen used to be drawn while hidden and came out blank for good;
  it is now drawn by the flip that shows it, and a theme switch redraws only the
  page on screen.
- **Codex and OpenCode**: `install.sh` registers the board with every client it finds
  on `PATH` (`claude mcp add`, `codex mcp add`, one key in OpenCode's `opencode.json`)
  and needs only one of the three; the Codex and OpenCode registrations carry
  `CLAUDE_BOARD_CLIENT`, the interactivity declaration the shim's no-human guard
  accepts in place of Claude Code's entrypoint (ADR 116); the manual is copied to
  `~/.agents/skills/` for Codex; `uninstall.sh` takes all of it back.

## 0.1.0 - 2026-08-12

claude-board is a local review surface for Claude Code: instead of asking questions
one at a time in a terminal, the agent posts a browser board carrying every question
and its rendered context at once, and you answer or comment on any of it before
sending one packet back.

- **The board**: markdown, diagrams, code, comparisons and rendered artifacts as
  blocks, each with its own answer widget; comment on a whole block, a diagram node
  or an element inside a rendered mock; unanswered comes back explicit, never
  defaulted.
- **Install**: as a Claude Code plugin, the repo its own marketplace, or from a
  clone; both run the same idempotent `install.sh`, which builds a signed launcher
  app to hold the macOS folder-access grant instead of `node` itself.
- **Security and browser access**: reads are gated behind a local credential; only
  a browser claude-board has authorized can open a board, and a bare `authorize.mjs`
  command opens a new one; a pre-launch audit hardened ids, cookies, working
  directory and uninstall.
- **The index page**: lists every thread with its rounds-left count, filters by
  title, project or thread id, and searches inside archived boards; a board
  double-clicked from Finder still renders read-only with no daemon running.
- **The menu bar item, and an optional pomodoro timer**: a status item giving quick
  access to the boards still waiting on an answer, plus a work timer it and the
  index page both read — off by default, opt-in from the settings panel — with its
  own boundary notification, cues chosen by ear, and a show/hide toggle that
  survives reinstall.
- **Tests and docs**: 56 checks (`npm run check`) covering the daemon, rendering
  and the install path, node only, no browser and no network; ADR, DESIGN,
  SECURITY, PROTOCOL and QUIRKS docs kept current alongside the code, plus an
  example skill showing how to build a board-backed interview, deliberately not
  installed.

Between tags, commit messages remain release-note grade: `git log` is the record
of what shipped since the last entry here.
