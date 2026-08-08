// The round badge's label -- pure and DOM-free, so it is checkable with no
// browser (test/check-pure.mjs). See PROTOCOL.md "Board document" for `rounds`.
// The round badge states position and total, not just total: `total` alone
// (the old label, `round ${rounds.length}`) was a real bug rather than a
// wording nitpick: on a two-round board it read
// "ROUND 2" while the reviewer was still looking at round 1.
//
// `current` is the round crossing the sticky header line, tracked client-side
// by an IntersectionObserver (src/ui.mjs) -- no scroll handler. `total` is
// `board.rounds.length`.
//
// Same discipline as src/patch.mjs's `computeBoardPatch`: one implementation,
// imported directly here for the node checks and embedded verbatim into the
// client script via `badgeLabel.toString()` (src/ui.mjs), so the tested string
// and the one a live tab actually renders can never drift apart -- a hand-copied
// reimplementation could silently diverge and nothing would notice. Also called
// server-side by src/render.mjs for the page's first paint, before any client
// script has run, so a fresh load and a post-hydrate re-render of the same two
// numbers are provably the same text.
export function badgeLabel(current, total) {
  return 'round ' + current + ' of ' + total;
}
