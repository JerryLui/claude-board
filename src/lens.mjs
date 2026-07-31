// The diagram lens's view math (SPEC_POLISH.md ticket 05), pure and separate from
// the DOM that renders it. A "view" is `{ x, y, s }` — exactly what
// `translate(x, y) scale(s)` on the lens canvas means, with the canvas's
// transform-origin pinned at its own top-left, so a canvas-local point `p` lands
// on screen at `x + s * p` and nothing here has to know about layout, scroll or
// element boxes.
//
// Split out of src/ui.mjs, and embedded back into its client script verbatim by
// `.toString()` (the same technique as `composeHint`/`parseMermaidDomId` in
// src/anchor.mjs and `badgeLabel` in src/badge.mjs), for the reason this repo has
// four recorded instances of: arithmetic that lives inline in a pointer handler is
// verified by eye, and "the diagram drifted off-screen when I zoomed" is exactly
// the class of defect no DOM stand-in can see and no reviewer reliably notices.
// Being pure, each of these is checkable against an arithmetic invariant rather
// than against a screenshot — see test/check-pure.mjs:
//
//   - `lensZoomAt`  the canvas point under the cursor is still under the cursor
//                   after the zoom (the invariant that makes scroll-to-zoom feel
//                   like zooming rather than like the diagram running away)
//   - `lensFit`     the whole diagram is inside the stage, and centred in it
//   - `lensOneToOne` scale is exactly 1, and the diagram is centred
//
// Anything either of these needs is declared INSIDE its own body: the embedded
// copies are literal function sources, so a module-level helper would simply not
// exist in the page.

/** Zoom `view` by `factor` about the stage-local point (`px`, `py`) — the point
 * under the cursor for a wheel/pinch zoom, the stage's own centre for a button.
 * Scale is clamped into [`min`, `max`] FIRST and the pan is then derived from the
 * clamped scale, so a zoom that hits the clamp is a no-op rather than a pan: the
 * invariant "the canvas point under (px, py) stays under (px, py)" holds at the
 * limits too, which it would not if the pan were computed from the unclamped
 * factor. Returns a new view; never mutates the one passed in. */
export function lensZoomAt(view, px, py, factor, min, max) {
  var s = Math.min(max, Math.max(min, view.s * factor));
  var k = s / view.s;
  return { x: px - k * (px - view.x), y: py - k * (py - view.y), s: s };
}

/** The view that fits a `w` x `h` diagram inside an `sw` x `sh` stage, centred.
 * Capped at 1: "fit" never magnifies a diagram smaller than the stage, because
 * blowing a two-node flowchart up to fill a 27" display is not what the control
 * is for — 1:1 is right there for that.
 *
 * Clamped into the SAME [`min`, `max`] band `lensZoomAt` clamps to, and for a
 * reason found in a browser rather than reasoned about: without a floor, a very
 * tall diagram fits at a scale BELOW the zoom floor (a 400x24000 flowchart in an
 * 800x600 stage fits at 0.025, well under 0.1), and the first wheel-out then
 * runs `Math.max(min, s * factor)` and moves the scale UP — the control zooms
 * in when asked to zoom out, once, and only on the diagrams big enough to need
 * the lens in the first place. Both arguments are optional and default to the
 * pre-clamp behaviour (`[0, 1]`), so a caller that does not care — every check
 * that exercises the arithmetic on its own — reads exactly as it did. `max` is
 * still capped at 1 whatever is passed: "fit" magnifying is a separate decision
 * from what the wheel is allowed to reach. */
export function lensFit(sw, sh, w, h, min, max) {
  var lo = min == null ? 0 : min;
  var hi = Math.min(max == null ? 1 : max, 1);
  var s = Math.min(Math.max(Math.min(sw / w, sh / h), lo), hi);
  return { x: (sw - w * s) / 2, y: (sh - h * s) / 2, s: s };
}

/** The view that shows the diagram at its own natural size, centred in the stage.
 * The offsets go NEGATIVE when the diagram is larger than the stage, which is the
 * point: 1:1 on a big diagram centres you on its middle and leaves the rest to be
 * panned to, rather than pinning you to its top-left corner. */
export function lensOneToOne(sw, sh, w, h) {
  return { x: (sw - w) / 2, y: (sh - h) / 2, s: 1 };
}
