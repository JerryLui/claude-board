# Changelog

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
- **The pomodoro timer and menu bar item**: a work timer the index page and a new
  status item both read, with its own boundary notification, cues chosen by ear,
  and a show/hide toggle that survives reinstall.
- **Tests and docs**: 56 checks (`npm run check`) covering the daemon, rendering
  and the install path, node only, no browser and no network; ADR, DESIGN,
  SECURITY, PROTOCOL and QUIRKS docs kept current alongside the code, plus an
  example skill showing how to build a board-backed interview, deliberately not
  installed.

Between tags, commit messages remain release-note grade: `git log` is the record
of what shipped since the last entry here.
