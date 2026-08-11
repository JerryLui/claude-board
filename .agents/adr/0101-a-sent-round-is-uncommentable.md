# 101. A sent round is uncommentable

2026-08-11 · widens 46, 98

**Context:** entry 46 made a page board that nobody is waiting on read-only and explicitly left
"an ordinary content round untouched", so a submitted ordinary board went on offering the
comment-mode toggle and every stage's own comment button over an exchange that had already
gone out. `commentArea` (src/render.mjs) had disabled the compose form behind that button
since the round went historical, which made the button an affordance that lied.
**Decision:** a round whose status is `sent` is uncommentable on every board, ordinary or page:
no toggle, no block comment button, and comment mode turns off rather than merely losing its
control. The comment list is untouched, since a settled round is exactly what gets re-read.
**Consequences:** `sent-page` becomes the fourth class in the toggle-hiding set alongside
`readonly`/`page-uncommentable`/`round-uncommentable`, and src/render.mjs now emits it at first
paint so the served bytes agree with the first `refreshPager` instead of showing the surface for
a frame; "Commentable" (CONTEXT.md) stops being a property of kind and awaitedness alone.
