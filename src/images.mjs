// Images the reviewer pastes into an answer or a comment (PROTOCOL.md "Submit"): the
// wire form a submit carries them in, the check that each is a real image of an allowed
// type, and the name each is stored under beside its board (src/store.mjs
// `writeBoardImages`). No filesystem here: a submit is refused whole before anything is
// written.

import { createHash } from 'node:crypto';
import { MAX_IMAGE_BYTES, MAX_SEND_IMAGE_BYTES } from './post-limit.mjs';

/** The allowed types, each with its stored extension and the leading bytes a real file of
 * that type starts with. The data URL's own type is a claim; these bytes are the check. */
const TYPES = {
  png: { ext: 'png', magic: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpeg: { ext: 'jpg', magic: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { ext: 'gif', magic: b => b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  webp: { ext: 'webp', magic: b => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

const CONTENT_TYPE = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** A stored image's name: the first 16 hex of its bytes' sha256, then its extension. The
 * one shape `GET /b/<boardId>/<name>` serves and a stored answer or comment may name. */
export const IMAGE_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;

const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/;

export function imageContentType(name) {
  return CONTENT_TYPE[name.slice(name.lastIndexOf('.') + 1)];
}

const mb = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const refuse = message => Object.assign(new Error(message), { status: 400 });

/** The decoded size of a base64 payload, read off its length so an oversized image is
 * refused before it is decoded. */
function decodedBytes(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - pad;
}

/** A submit's `answers` and `comments` with every `images` entry turned from a data URL
 * into its stored name, plus `files` (name -> bytes) to write. Throws a 400 naming the
 * fault for anything that is not an array of data URLs of an allowed type whose bytes are
 * that type, for an image over MAX_IMAGE_BYTES, and for a submit whose images together
 * pass MAX_SEND_IMAGE_BYTES. An entry with no `images`, or an empty array, is passed on
 * without the key, so a text-only submit is exactly what it was. */
export function decodeSubmitImages({ answers, comments }) {
  const files = new Map();
  let total = 0;
  const convert = (entry, label) => {
    if (!entry || typeof entry !== 'object' || !('images' in entry)) return entry;
    const { images, ...rest } = entry;
    if (images == null) return rest;
    if (!Array.isArray(images)) throw refuse(`${label} "images" must be an array of image data URLs`);
    if (!images.length) return rest;
    const names = images.map((url, i) => {
      const m = typeof url === 'string' ? DATA_URL.exec(url) : null;
      if (!m) throw refuse(`${label} image ${i + 1} is not a PNG, JPEG, GIF or WebP data URL`);
      const size = decodedBytes(m[2]);
      if (size > MAX_IMAGE_BYTES) throw refuse(`${label} image ${i + 1} is ${mb(size)}, over the ${mb(MAX_IMAGE_BYTES)} limit for one image`);
      total += size;
      if (total > MAX_SEND_IMAGE_BYTES) throw refuse(`the images in this Send come to over ${mb(MAX_SEND_IMAGE_BYTES)}, the limit for one Send`);
      const bytes = Buffer.from(m[2], 'base64');
      const type = TYPES[m[1]];
      if (!type.magic(bytes)) throw refuse(`${label} image ${i + 1} is not a real ${m[1].toUpperCase()} image`);
      const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${type.ext}`;
      files.set(name, bytes);
      return name;
    });
    return { ...rest, images: names };
  };
  return {
    answers: Array.isArray(answers) ? answers.map((a, i) => convert(a, `answer ${a && a.id ? a.id : i + 1}`)) : answers,
    comments: Array.isArray(comments) ? comments.map((c, i) => convert(c, `comment ${i + 1}`)) : comments,
    files,
  };
}

/** The stored-name list an answer or comment keeps: names of the stored shape only, the
 * key absent when there are none. What `applySubmit` (src/board.mjs) copies onto the board,
 * so a submit that reaches it without `decodeSubmitImages` cannot store a path. */
export function storedImages(images) {
  const names = Array.isArray(images) ? images.filter(n => typeof n === 'string' && IMAGE_NAME.test(n)) : [];
  return names.length ? { images: names } : {};
}

/** Every image name `board`'s answers and comments hold. */
export function boardImageNames(board) {
  const names = new Set();
  for (const a of Object.values(board.answers || {})) for (const n of (a && a.images) || []) names.add(n);
  for (const c of board.comments || []) for (const n of c.images || []) names.add(n);
  return names;
}
