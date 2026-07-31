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
