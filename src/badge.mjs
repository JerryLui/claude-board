// Pure, DOM-free facts about a round, so they are checkable with no browser
// (test/check-pure.mjs) AND shared by the two sides that must agree about them:
// src/render.mjs renders them server-side, src/ui.mjs embeds each one's literal
// source via `.toString()` and runs the same code in the tab. This module is the
// one place either can import from -- src/ui.mjs cannot import src/render.mjs
// (render.mjs imports the client script, so the edge would be circular).
// See PROTOCOL.md "Board document" for `rounds`.
// The round badge states position and total, not just total: `total` alone
// (the old label, `round ${rounds.length}`) was a real bug rather than a
// wording nitpick: on a two-round board it read
// "ROUND 2" while the reviewer was still looking at round 1.
//
// `current` is the round whose page is on screen -- the board's pages are its
// rounds (ADR.md entry 42), so the badge names the page the pager last flipped
// to (src/ui.mjs's goToRound). `total` is `board.rounds.length`.
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

// A round's own name, used in two places that must agree: the round label
// src/render.mjs prints at the top of an ordinary round, and the entry the round
// pager gives that same round at the bottom of the page (ADR.md entry 42 -- "a
// pill at the bottom naming the rounds"). The pager is how a reviewer picks a
// round BY NAME, so the name it offers and the name the page carries have to be
// the same string; they are, because this is the only place either is built.
// Embedded into the client script by `.toString()` exactly like badgeLabel
// above, since the pager is rebuilt live whenever a round arrives or is sent.
export function roundPageLabel(n, title) {
  return title ? 'Round ' + n + ' · ' + title : 'Round ' + n;
}

// Is this list of blocks a PAGE -- one rendered artifact filling the viewport,
// rather than a stage in a column? ADR.md entry 33: inferred from shape, never
// declared, so nothing enters the protocol. Entry 42 made it a question about a
// ROUND rather than about a whole board: a thread keeps its single board, so the
// artifact round stays a full-viewport page for good and the question round that
// follows it is an ordinary page next door. src/render.mjs asks it of a round's
// blocks when it renders, and re-exports it as isPageBoard for a whole board;
// src/ui.mjs asks it of the same blocks again on every flip, to decide whether
// the page now on screen is laid out as a page board.
//
// A block whose reference failed to resolve is excluded deliberately: there is
// no stage to fill anything with, only the red "could not resolve" card, and a
// page board's chrome would render that error alone across the viewport.
export function isPageRound(blocks) {
  return blocks.length === 1 && blocks[0].kind === 'html' && !blocks[0].error;
}
