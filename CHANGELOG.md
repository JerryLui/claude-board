# Changelog

## Unreleased

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
