# 1. Theme selection is client-side only

2026-07-30

**Context:** a server-read theme cookie would break the asserted byte-identity of the served page and its `pages/*.html` archive. **Decision:** the theme is chosen entirely in the browser — media query default, `localStorage` override, applied by an inline script before first paint. **Consequences:** the preference is scoped to scheme+host+port, and `src/theme.mjs` gates every storage access on `location.protocol !== 'file:'` so an archive reads no `file://`-wide preference.
