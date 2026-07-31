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
set of roots, supplied as `CLAUDE_BOARD_REF_ROOTS` (colon-separated absolute paths) and
defaulting to `~/.claude`. Each root is validated exactly as `resolveBoardCwd` already
validates `cwd`: realpath'd, must be an existing directory, refused if it is `/` or
`$HOME` or above.

**Consequences:** Widens what a confused or hostile agent can pull into a board, and
boards embed the content they resolve — so this enlarges the corpus reachable by anyone
holding the session cookie. `SECURITY.md`'s statement of the reference boundary has to be
rewritten rather than amended. The daemon runs under launchd, so the variable must reach
it through the plist and therefore through `install.sh`; a misconfigured root silently
widens the gate, which is the cost of making it configurable at all. Rejected: hardcoding
`~/.claude` (smallest widening, but every other tool's config is then unreachable);
rejected: dropping confinement entirely, which is more honest about the weak boundary but
rewrites the security posture for a convenience fix.
