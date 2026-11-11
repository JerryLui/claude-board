// The spin-down flag: one flag in the store root that every session bound to a mission, and
// any successor, reads off `GET /api/binding`, and the Missions view off `GET /api/missions`.
// While it is on, no merge, deploy or release step runs; the sessions' own rules hold that
// gate, and this module only stores and answers the flag. The Master Chief's `/spin-down`
// sets it and clears it through `POST /api/spin-down`.

import { boardHome, readSpinDownFile, writeSpinDownFile } from './store.mjs';

const MAX_BY_CHARS = 200;

function refuse(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** `GET /api/spin-down`: `{ on: false }`, or `{ on: true, at, by? }`, `at` the time it was
 * turned on and `by` who turned it on, as they wrote it. */
export function readSpinDown(home = boardHome()) {
  const flag = readSpinDownFile(home);
  if (!flag) return { on: false };
  return {
    on: true,
    ...(typeof flag.at === 'string' ? { at: flag.at } : {}),
    ...(typeof flag.by === 'string' ? { by: flag.by } : {}),
  };
}

/** The flag as the overview and a binding carry it: `{ on, at? }`. */
export function spinDownBrief(home = boardHome()) {
  const { on, at } = readSpinDown(home);
  return at === undefined ? { on } : { on, at };
}

/** `POST /api/spin-down`, `{ on: true | false, by? }`: on stores the flag stamped `now`,
 * keeping the first `at` and `by` while it is already on; off removes it. Answers the
 * flag as `readSpinDown` reads it. Any other field, or a wrong type, is a 400 that writes
 * nothing. */
export function setSpinDown(body, { home = boardHome(), now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('the body must be a JSON object');
  for (const k of Object.keys(body)) {
    if (k !== 'on' && k !== 'by') throw refuse(`the body has an unknown field: ${k}`);
  }
  if (typeof body.on !== 'boolean') throw refuse('on must be true or false');
  if (body.by !== undefined && (typeof body.by !== 'string' || body.by.length > MAX_BY_CHARS)) {
    throw refuse(`by must be a string of at most ${MAX_BY_CHARS} characters`);
  }
  if (!body.on) {
    writeSpinDownFile(null, home);
    return { on: false };
  }
  const held = readSpinDown(home);
  if (held.on) return held;
  return writeSpinDownFile({ on: true, at: new Date(now).toISOString(), ...(body.by !== undefined ? { by: body.by } : {}) }, home);
}
