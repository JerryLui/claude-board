# PROTOCOL — shared contract for `claude-board`

This file is the integration contract every ticket builds against. It is derived from
`DESIGN.md` (Decisions → "One block document, two modes") and fixes the details the
spec leaves elliptical, so that independently-built chunks compose.

**Rules for changing this file:** if a ticket needs a shape that is not here, add it here
in the same commit that uses it, additively. Do not repurpose or rename an existing field.

## Layout

```
bin/daemon.mjs      launchd entry point; boots the HTTP server
bin/mcp.mjs         stdio MCP shim, one per Claude session
src/store.mjs       board JSON persistence: read, write, list, search
src/board.mjs       model: id minting, block normalisation, rounds, packet assembly
src/markdown.mjs    markdown -> HTML + anchor extraction (runs in node and the browser)
src/anchor.mjs      element-level (dom/mermaid) anchor path/hint logic, pure; src/ui.mjs
                     carries a duplicate as plain functions since the served page has no
                     import graph at runtime (see its file comment)
src/resolve.mjs     content-by-reference resolution and sha snapshotting
src/render.mjs      board JSON -> complete HTML page (pure function)
src/server.mjs      node:http daemon: routes, SSE, loopback Host check, read + write auth
src/secret.mjs      the two credentials: the local secret (where it lives, constant-time
                     comparison) and the browser session cookie derived from it; shared
                     by the daemon and the shim
src/handoff.mjs     single-use, seconds-lived browser handoffs, and the recovery command
                     every refusal names
src/indexpage.mjs   daemon root: thread index and archive search
src/ui.mjs          client-side script, exported as a string
src/styles.mjs      page CSS, exported as a string
src/theme.mjs       client-side theme selection: storage key, THEME_CHANGE_EVENT, the
                     pre-paint boot script, and the control's markup. src/render.mjs and
                     src/indexpage.mjs splice themeBootScript/themeToggle() into the page
                     they emit; src/ui.mjs imports only THEME_CHANGE_EVENT, baked into its
                     own separately-emitted client script. themeBootScript's inline
                     <script> in <head> and ui's <script type="module"> at end of body are
                     two independently-loaded contexts with no shared scope, agreeing on
                     that event name with nothing at build time enforcing it
src/patch.mjs       pure board-JSON diff (added/changed block ids, rounds now sent),
                     walking nested blocks too; imported directly by the checks AND
                     spliced verbatim into src/ui.mjs via computeBoardPatch.toString(),
                     so one implementation runs in node and in the page
commands/grill.md   the /grill command; the first caller of the `ask` tool
test/check-pure.mjs test/check-http.mjs test/check-mcp.mjs
test/check-install.mjs test/check-grill.mjs test/run.mjs
install.sh
```

Zero dependencies: `node:*` built-ins only, ESM (`.mjs`) throughout, no bundler, no build
step. Mermaid is the sole exception and stays client-side from its CDN.

## Paths

The store root is `CLAUDE_BOARD_HOME`, defaulting to
`~/Library/Application Support/claude-board`. Unlike the other env vars here, this one is
user-facing configuration as well as the seam the checks run against.

```
$CLAUDE_BOARD_HOME/boards/<boardId>.json    the board document, the only mutable truth
$CLAUDE_BOARD_HOME/pages/<boardId>.html     emitted projection, standalone-openable
```

Daemon listens on `127.0.0.1:7391` (`CLAUDE_BOARD_PORT` overrides, for the checks).

## Identifiers

`th_<8 lowercase hex>` for threads, `b_<32 hex>` for boards, `q1` / `c3` / `m2` … for blocks
(kind letter + ordinal within the board, stable once minted). Comments are numbered `1..n`
across the whole board — that number is what appears in the pin.

The board id is 16 bytes, widened from 4 (audit 2026-07-28, M7). At the time read routes
were open, which made the id the de facto capability gating `GET /b/:id`; reads are gated
now, so the id is defence in depth rather than the only defence — and 16 bytes stays,
because an id also appears in redirect targets and in whatever a reviewer pastes into
chat. Thread ids stay 4 bytes — a thread is an index label and authorises nothing.

A block id is **unique across the whole board** (additive, audit 2026-07-28): `board.answers`
is keyed by it, so a duplicate is not a cosmetic clash, it is the agent being told an answer
the reviewer never gave. A caller-supplied `raw.id` is legitimate only on the amend
"replace this exact block" path, and is refused unless it (a) matches the minted shape,
(b) carries the kind letter of the block it names, and (c) is either unused or names a
top-level block of the round currently being amended. `addRound` refuses every id already
on the board.

Kind letter, one per block kind (`m` is mermaid per the worked example above, so markdown
uses `d` for document to avoid the collision):

```
question -> q     markdown -> d     mermaid -> m
code     -> c     html     -> h     compare  -> x
```

## Board document

```js
board = {
  id, thread, title,
  cwd,                              // project directory of the session that owns the thread
  createdAt, updatedAt,             // ISO 8601
  state,                            // 'open' | 'submitted' | 'discuss' | 'timeout'
  rounds: [ { n, postedAt, status, sentAt, title } ],   // status: 'open' | 'sent'
  blocks: [ Block ],                // every block of every round, in display order
  answers: { [questionBlockId]: Answer },
  comments: [ Comment ],
}
```

Answers are keyed at board level rather than nested in rounds; every block carries its own
`round`, which is what the history rail groups by.

**Round `title`** (additive, audit 2026-07-28). Every round carries the `title` of the post
that created it — `ask` requires a non-empty one on every call and `commands/grill.md` tells
the agent to make it the branch name. `createBoard` seeds round 1's from the board title,
`addRound` takes the post's (falling back to the board title), and `amendRound` may refine
the open round's but never blanks it. `src/render.mjs` renders it in the round heading:
`Round 2 · fix/some-branch`, plus ` · sent` once the round is out. Previously the value was
posted, passed to `addRound`/`amendRound` and dropped there, so a thread that ran five rounds
across five branches showed five identical `Round N` headings.

### Blocks

Every block has `{ id, round, kind }`. Content blocks additionally carry the resolved
snapshot — `text` and `sha` — written once at post time and never re-read (see
"Questions by value, content by reference, snapshotted at post time").

```js
{ kind: 'markdown', source: Ref|null, text, sha, html, anchors: [Anchor], error? }
{ kind: 'mermaid',  source: Ref|null, text, sha, error? }
{ kind: 'code',     source: Ref,      text, sha, lang, error? }
{ kind: 'html',     html }                        // by value; hand-mocked stage, no source
{ kind: 'compare',  left: { label, block }, right: { label, block } }
{ kind: 'question', prompt, context: [ContentBlock], widget, options: [Option] }

Ref    = { path, section?, lines? }               // lines is [from, to], 1-based inclusive
Option = { label, description?, preview? }
widget = 'single' | 'multi' | 'text' | 'rank'
```

A widget outside that list is a **400**, not a silent fallback to `single` (additive, audit
2026-07-28) — `{ widget: 'freetext' }` rendered a question with no cards and no textarea,
which Send then reported back as `unanswered`, so the agent misreported an unanswerable
question as "the reviewer left it blank". A `single`/`multi`/`rank` question with zero
options is a 400 for the same reason; `text` needs none.

`error` (additive, ticket 03): when a block carries `source` and `src/resolve.mjs`
fails to resolve it (missing file, out-of-range lines, section not found), the block
is still minted and kept — `text` comes back `''` and `sha` the hash of the empty
string — with `error` set to a human-readable reason. The page renders the block
with that reason visible instead of silently dropping it or aborting the whole post.
A block with no `source` (by-value `text`) never sets `error`.

**`cwd` is bound once, per thread** (additive, audit 2026-07-28). `cwd` is the root every
reference below is confined to, so it is the single value that decides what a board can
read — and confinement is vacuous if a later post can move it. It is accepted only on the
post that creates the thread, and is validated there (a **400**, since there is a caller
to tell):

```
relative                             refused: it would resolve against the daemon's own cwd
not an existing directory            refused
the filesystem root                  refused
$HOME, or any directory above it     refused: every project at once, plus keys and history
```

The value stored on the board is the **realpath**, so what the board records is the actual
directory its content came from. A post carrying `boardId` may repeat the board's own `cwd`
but may not change it; a post naming an existing `thread` inherits that thread's directory
(`createBoard`'s additive `threadCwd`) and may not change it either. A board with no `cwd`
resolves no references at all — it does not fall back to the daemon's own working
directory, which is a directory nobody chose and no board records.

This bounds and stabilises the read; on its own it does not authenticate the caller. That
last step is now closed by the local secret (see "The local secret" below): a board can only
be created, and therefore a `cwd` can only be named, by a caller holding it.

The thread's directory is looked up **server-side**, from the oldest board in the thread,
and passed to `createBoard` as `threadCwd` — the caller does not get to assert what the
thread is bound to. A post naming an existing `thread` and a different `cwd` is a **400**
(`cannot retarget thread: ...`) and creates nothing.

**Reference confinement and caps** (additive, audit 2026-07-28). A `Ref.path` names a
file *inside the board's `cwd`* and nothing else, and every violation is an `error` on
the block — never a throw, never a read:

```
absolute path                        refused outright
realpath outside cwd                 refused (covers ../ traversal AND symlinks out)
not a regular file                   refused (a fifo blocks the daemon's only thread
                                      forever; a character device exhausts its heap)
larger than 512 KiB                  refused, by stat, before anything is opened
line range past end of file          refused at BOTH ends (a trailing newline does not
                                      make a phantom last line)
```

A markdown `section` is located with the same fence-aware scan `src/markdown.mjs`
uses, so the slug the agent is shown for a heading is the slug that resolves.

The same 512 KiB cap applies to by-value `text` and `html`, where it is a **400 on the
post** rather than a block-level `error`: by-value content came from the caller, so
there is a caller to tell.

### Answers, comments, anchors

```js
Answer  = { id, status, choice, note }
          // status: 'answered' | 'unanswered' | 'deferred'
          // choice: string (single, text) | string[] (multi) | string[] ordered (rank) | null
          // note is always present, '' when empty. unanswered is explicit, never a default.

Comment = { n, blockId, anchor, text, createdAt, round }

Anchor  = { kind: 'block' }                             // whole block
        | { kind: 'md',      ref, label }               // heading slug + ordinal
        | { kind: 'dom',     ref, hint }                // "N.N.N" child-index path + a composed hint,
                                                         // see below -- applies page-wide, not just to
                                                         // an html stage (DESIGN.md ticket 03)
        | { kind: 'mermaid', ref, domRef, hint }        // node id, plus the same "N.N.N" path + hint
                                                         // every other element-level anchor carries;
                                                         // ref is the fallback the generic domRef/hint
                                                         // leans on, never the model (DESIGN.md
                                                         // ticket 05) -- domRef/hint are absent on an
                                                         // anchor minted before that ticket
```

Markdown anchor ids are the heading slug, plus `-liN` for the Nth top-level list item under
that heading: `acceptance-criteria`, `acceptance-criteria-li4`. Stable while the section's
shape is unchanged. An anchor of any kind that no longer resolves at render time is
reported, not dropped: the comment survives with `resolved: false` and a `lost` field
naming what it lost (`src/board.mjs`'s `lostLabel`) — the stored `hint` for a `dom` anchor
or a `mermaid` anchor minted since ticket 05 (DESIGN.md), the bare `ref` for
everything else, including a `mermaid` anchor minted before that ticket (no `hint` to fall
back to).

Additive (audit 2026-07-28), all three keeping ids unique and resolvable:

- **Top-level list items that precede every heading** anchor under the synthetic section
  prefix `_body`: `_body-li1`, `_body-li2`. Criterion 5 states the rule unconditionally,
  and a headingless source (a bare criteria list) previously yielded zero anchors. The
  underscore is what makes the prefix safe: `slugify` strips `_`, so no heading can ever
  produce this string.
- **Slug and label come from the RAW heading text**, before HTML escaping. `## Risk &
  Reward` is `ref: 'risk-reward'`, `label: 'Risk & Reward'` — the same slug
  `section: 'risk-reward'` resolves, and a label every consumer escapes exactly once.
- **A quoted (`>`) heading or bullet mints no anchor and carries no id**, and consumes
  neither a slug nor a `-liN` ordinal.

A `dom` ref's index chain is 1-based over `Element.children` **as the browser parses the
markup** — implied `tbody`, auto-closed `p`/`li`/`tr`/`td`/`option`, and `script`/`style`
counted as elements. `src/ui.mjs` mints it against the live DOM and `src/anchor.mjs`
resolves it against the snapshot; the two trees have to agree node for node or a live
element reports lost.

A `dom` anchor's root depends on which block it names (DESIGN.md ticket 03/04):
for an `html` block, root is that stage's sandboxed iframe body, resolved by
`resolveDomAnchor`; for every other block kind (markdown, code, question, compare, and a
`mermaid` block's own chrome), root is the anchored block's own `<section
data-block-id>`, re-rendered from its stored content (`src/render.mjs`'s `renderBlock`)
and resolved by `resolveDomAnchorInSection`. This is what makes a `dom` anchor page-wide —
any element the board renders can carry one, not only content inside an html stage.

`hint` is not a bare text snippet either. `composeHint` (`src/anchor.mjs`, mirrored
client-side in `src/ui.mjs`) starts from the clicked element's own text, falling back to a
role word (`button`, `link`, `field`, `image`, `menu`) for a handful of role-bearing tags
with none, or the tag name for anything else empty. Only inside one side of a `compare`
block does it go further: the role word is appended after real text too (`"Send button"`,
not just `"Send"`), and the whole identity is suffixed with `" in <context>"`, where
`<context>` names that side's label plus the block kind it holds (`"Before html stage"`,
`"After diagram"`). Outside a compare, a hint is exactly the plain snippet it always was.

## Packet — what the `ask` tool returns

```js
{
  board, thread, title, round,
  status,                           // 'submitted' | 'discuss' | 'timeout' | 'error'
  answers:  [ { id, round, prompt, widget, status, choice, note } ],
  comments: [ { n, blockId, blockKind, anchor, text, round, createdAt, resolved, lost? } ],
  url,
}
```

`discuss` means the reviewer chose Discuss in chat: partial answers are included and the
agent must stop posting boards for the rest of the session. `timeout` is the wall-clock cap
(default 2h) and carries an explicit no-response.

**Scope: one packet is one round** (additive, audit 2026-07-28 — this was previously
unpinned, which is why it diverged). `answers` holds exactly the question blocks whose
`round` is the packet's `round`, and `comments` exactly the comments left in it. Round 6
does not redeliver rounds 1-5: the agent would re-address settled feedback and re-report an
old `unanswered`/`deferred` as a fresh signal, louder each round. Every entry additionally
carries its own `round` (and each comment its `createdAt`), so a caller that genuinely
wants the thread's history reads `board.answers` / `board.comments` and can still tell the
rounds apart. The stored board keeps everything; the packet is the round.

**`status` is the only thing that says whether a question was decided; `choice` is not.**
A caller must branch on `status` and never on `choice` being non-null, because the three
statuses do not agree about `choice`:

- `answered` — `choice` holds the answer.
- `deferred` — `choice` may ALSO hold a selection. The reviewer can pick an option and
  still mark it "revisit later", and that tentative lean is worth carrying rather than
  discarding. A caller that reads `choice` alone therefore records a decision the reviewer
  explicitly declined to make.
- `unanswered` — `choice` is `null`.

Found by using this: a round came back with a `deferred` question whose `choice` was
populated beside an `unanswered` one whose `choice` was `null`, and nothing here said which
was the contract and which was an accident.

`answers` covers **every** question block of that round, including ones nested in another
question's `context` or in a compare side — the renderer makes those live widgets and the
page submits them, so dropping them would lose an answer the reviewer actually gave. An
answer whose id is not a question block of the round being submitted is ignored server-side
rather than stored.

## HTTP surface

Posting and waiting are separate routes on purpose, so the spec's escape hatch (splitting
`ask` into post + collect) stays cheap. Every route refuses a request whose `Host` header
is not loopback, with 403 and no body.

Four gates, in order: loopback `Host` (403), same-origin on every non-GET (403), a
credential on every non-GET (401), a credential on every GET but two (401). Both credential
gates are written as "everything, minus an explicit exception list", so a route added later
is gated by default rather than by whoever adds it remembering.

The Host check does not cover a browser: a page on any origin doing
`fetch('http://127.0.0.1:7391/...')` has its `Host` set to loopback by the browser itself.
So every non-GET additionally refuses (403, no body) when `Origin` is present and is not
the daemon's own origin, or when `Sec-Fetch-Site` is present and is not `same-origin`, and
every body must be `Content-Type: application/json` (415 otherwise) — `text/plain` and the
form encodings are CORS simple requests and need no preflight. Non-browser clients (the
shim, curl, the checks) send neither header and are unaffected. Every HTML response also
carries `X-Frame-Options: DENY` and a `frame-ancestors 'none'` CSP.

### The local secret

Additive, audit 2026-07-28; `DESIGN.md` Decisions → "A loopback Host check, an origin
check, and a local secret". The Host check closes the network and the origin check closes
the browser. Neither can see a **local process**: anything able to open a socket to
`127.0.0.1:7391` could post its own board naming a `cwd` it picked and read that directory
back off the served page — and because the daemon runs always-on under launchd as the login
user, that read is laundered past macOS TCC, which would otherwise gate `~/Documents`,
`~/Desktop` and `~/Downloads` per application.

```
~/.config/claude-board/secret      0600, in a 0700 directory; 32 random bytes as hex
                                   generated by install.sh, NEVER rotated by a reinstall
                                   (CLAUDE_BOARD_SECRET_FILE relocates it, for the checks)
x-claude-board-secret: <secret>    request header; read once at daemon startup, compared
                                   with crypto.timingSafeEqual, length-guarded
```

**Every non-GET request** must carry it — except `POST /api/board/:id/submit`, which also
takes the session cookie below — so a write route added later is gated by default rather than
by remembering. A missing or wrong credential is **401 with no body** on a write: nothing
about what is behind it, not even whether the board exists. A daemon that finds no secret
file says so on stderr at startup and refuses everything gated: it fails closed, never open.
`bin/mcp.mjs` reads the secret at startup, sends it on every call, and refuses to post at all
(naming `./install.sh`, writing nothing) when it has none or the daemon answers 401.

### The browser session cookie

`SPEC_LAUNCH.md` Decisions → "Read routes are gated", overturning `DESIGN.md`'s "read
routes stay open". **Every route but `GET /api/health` and `GET /auth/:token` now requires a
credential**, reads included: `GET /`, `GET /b/:id`, `/api/search`, `/api/board/:id/wait` and
the SSE stream. What that closes: any local process that could reach the port used to read
every board — source excerpts, questions, answers — and forge an answer on any board whose
page it could fetch.

The browser cannot read a 0600 file, so it holds this instead:

```
Set-Cookie: cb_session=<HMAC-SHA256(secret, "claude-board/session/v1")>;
            Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict
```

Host-only (no `Domain`), `HttpOnly`, `SameSite=Strict`, and **not** a session cookie: a
bookmarked board opened days later has to work. No `Secure`, and none is possible — the
daemon serves plain http on loopback, so a `Secure` cookie would never be sent back.

**Derived from the secret, not random**, which is what makes it survive a daemon restart:
any daemon holding the same secret accepts the same cookie, so `launchctl kickstart`, a
crash and a code reload are all invisible to an open browser. Rotating the secret invalidates
every browser at once — intended.

Its strength, precisely: "may read every board and answer any open round". It is refused in
the `x-claude-board-secret` header, so it can never create a board and therefore never make
the daemon resolve a file. It is **not** scoped to one board; the board-scoped submit
cookie that used to sit beside it — an HMAC of the board id, minted for whoever could fetch
that board's page — is deleted, because with reads gated it was strictly weaker than the
credential the reader already had to present.

### Authorizing a browser

A credential never appears in a URL a bookmark can capture. Instead:

```
POST /api/handoff       { boardId? }  (secret required)  -> { token, expiresAt, ttlMs }
GET  /auth/<token>      302 -> /b/<boardId> (or /), Set-Cookie: cb_session=…
```

`POST /api/handoff` mints a **single-use, ~30s** token (`CLAUDE_BOARD_HANDOFF_TTL_MS`
overrides, for the checks). It takes the secret only — the session cookie is refused here, so
a browser cannot mint itself a second credential. The caller names a *board*, never a path:
anything that is not a board id redirects to the index, so there is no attacker-chosen
redirect target to validate.

`GET /auth/<token>` consumes it, sets the cookie, and redirects to a **clean** URL. Expired,
already used, and never existed are one indistinguishable refusal. The token is process-local
state, so it does not survive a daemon restart — the opposite of the cookie it hands out, and
deliberately so.

The shim opens the tab on a handoff URL rather than a board URL, and rebuilds that URL from
its own base URL and the returned token rather than trusting anything in the response body.

`node bin/authorize.mjs` (`npm run authorize`) is the recovery command: it mints a handoff
and opens the browser. `--print` emits the URL instead, for a second profile or a different
browser; an optional board id argument lands on that board rather than the index. The refusal
page below names this command with an absolute path, and `src/handoff.mjs` `recoveryCommand()`
is the single source of that string.

### Refusing a caller with no credential

**401, one status code everywhere**, matching what writes have always answered. No
`WWW-Authenticate` header: it would raise a browser password prompt in front of the page that
explains the actual fix, and there is no password to type.

A **browser navigation** (a path outside `/api/` whose `Accept` includes `text/html`) gets an
HTML page naming the recovery command verbatim, because the caller being refused is a human
looking at a tab. Everything else — `/api/*`, the SSE stream, curl, the shim — gets
`{ error, recover }` as JSON and no markup. Neither reveals anything about the store: the
same page is served whether or not the board exists.

```
GET  /                              thread index + archive search
GET  /b/:boardId                    the served page
GET  /api/health                    { ok: true, version }        (open: install.sh polls it)
GET  /auth/:token                   consume a handoff -> 302 + Set-Cookie  (open by necessity)
POST /api/handoff                   { boardId? } -> { token, expiresAt, ttlMs }
POST /api/board                     post a board or a round into a live thread
                                    -> { boardId, thread, round, url }
GET  /api/board/:id/wait?round=N    blocks until the round is sent -> Packet
GET  /api/board/:id/events          SSE: round pushes, state changes
POST /api/board/:id/submit          { action: 'send'|'discuss', answers, comments }
GET  /api/search?q=                 archive search
```

`POST /api/board` body shape (additive — not pinned above): `{ title, blocks, cwd?, thread? }`
to start a new thread, or `{ boardId, blocks, title? }` to push into a live one. `cwd` is only
meaningful on the thread-creating form and is validated there (see "`cwd` is bound once,
per thread" above); on the `boardId` form it may repeat the board's own value but never
change it. `title` is meaningful on **both** forms: on the `boardId` form it labels the round
being minted or amended (see "Round `title`"). Pushing into a live
board amends the currently open round in place (a block whose incoming id already exists on
the board replaces it, everything else is appended to that same round) when the latest round
is still `open`; it mints a new round only once the latest round's status is `sent`. Either
way the response is unchanged: `{ boardId, thread, round, url }`, `round` naming whichever
round was amended or minted.

`GET /api/board/:id/wait?round=N` has a server-side wall-clock ceiling matching
`CLAUDE_BOARD_TIMEOUT_MS` (default 2h): when it fires the call returns 200 with a packet
whose `status` is `timeout`, carrying whatever partial answers the store holds. A client
that disconnects ends the wait outright — nothing is written and the poll stops.

`POST /api/board/:id/submit` body shape (additive — not pinned above). `round` is
**required** and names the round being answered: a submit that omits it is a 400, and one
naming any round other than the currently-open one is a 409 whose body carries
`{ error, board, round }` with `round` naming the round that IS open (`null` when the
board has no open round at all), so a stale client can resync rather than silently
overwrite a sent round.

```js
{
  round: 1,                                        // required; must be the open round
  action: 'send' | 'discuss',
  round,                                           // additive: the round this submit is for
  answers:  [ { id, status?, choice, note? } ],   // status defaults to 'answered' when
                                                    // choice is present, 'unanswered' otherwise;
                                                    // any question block with no entry here is
                                                    // synthesised as unanswered server-side
  comments: [ { blockId, anchor, text } ],         // n, createdAt, round are assigned server-side
}
```

`round` (additive) names the round the page believed was open when the reviewer pressed the
button. It exists so a submit aimed at a round that has already been sent can be refused with
**409** instead of silently re-applying: without it, a second tab — or a plain double-click, since
the send bar sits outside the round section and so is never disabled by the history collapse —
appends the same comments a second time under fresh numbers, and re-applies answers to a round
that already went out. A client that gets a 409 treats it as "already sent" and stops offering to
send that round again; it is not an error state.

### The two ways out of a round

`action` is the whole difference between them, and the body is otherwise identical — the page
posts the same answers and the same queued comments either way, because `discuss` is defined as
returning *whatever is filled in*, not a degraded second path:

- `'send'`   → `board.state = 'submitted'`, packet `status: 'submitted'`.
- `'discuss'` → `board.state = 'discuss'`, packet `status: 'discuss'`; partial answers are
  included and the calling agent must stop posting boards for the rest of the session.

The page renders both as buttons in one `.send-bar` (`#send-btn`, `#discuss-btn`, `src/render.mjs`),
which `body.readonly` hides wholesale — so the standalone `file:` archive offers neither.

### Marking an already-open tab

"Open once, then badge and notify" (DESIGN.md) splits across two owners. Page side, on a
`round` push: a pending count in `document.title`, a badge drawn onto a data-URI favicon (canvas,
no asset file — the page must stay a single self-contained file), and, only when the document is
hidden or unfocused, a `Notification`. Permission is requested lazily on the first round that
would actually notify, a denial is never re-prompted, and every part degrades silently: a failure
anywhere leaves the round pushed and the page working, just unmarked. The page never calls
`window.focus()` — the notification is what replaces the focus steal. All of it is inert in
readonly mode. Shim/daemon side, unchanged: reopening the tab when no client is connected at all,
and printing the board URL in chat as the fallback that cannot fail.

## SSE events

`GET /api/board/:id/events` (additive to the HTTP surface above, ticket 04): a `text/event-stream`
subscription, one per connected client, for round pushes and submits on `:id`. 404s up front if
the board doesn't exist; otherwise the response never ends on its own — it stays open until the
client disconnects. Heartbeat comment lines (`: heartbeat\n\n`) keep it alive through idle timers
and proxies; `CLAUDE_BOARD_SSE_HEARTBEAT_MS` overrides the cadence (default 15000), for checks
only — never set by a user. Comment lines are invisible to `EventSource`'s message events, so
they never surface as a stray event to client code.

Two named events, both carrying the full board JSON (the same shape a served page inlines) so a
client can diff against its own last-known copy and update it, plus enough to apply the push
without a full reload:

```js
event: round      data: { round, mode: 'new-round' | 'amend', blockIds, html, board }
event: submitted  data: { round, board, html }
```

`submitted`'s `html` (additive, not in the original pinning of this event): the
re-rendered `<section class="round">` for `round`, now in its sent/history form — the
same `renderRoundSection` output a full page load would produce for it. Without it a
client that did not submit would have to disable its own on-screen copy by hand, which
leaves that tab showing its own unsent, in-progress state as if it were what was sent.
A client that receives no `html` must fall back to disabling the round in place.

`html` is a pre-rendered fragment covering exactly `blockIds` — never the whole page — so the
client only ever inserts or replaces that much DOM: `renderRoundSection`'s output (a full
`<section class="round">` wrapper) for `mode: 'new-round'`, or one `renderBlock` call per touched
id (no wrapper) for `mode: 'amend'`, since the round section the amended blocks belong to already
exists client-side. `submitted` fires on every submit, to every connected client including the one
that just submitted, so a second tab collapses the round into its history rail without reloading.

The client subscribes only when NOT running read-only from `file:` (see "Detecting a session with
no human in it" for the analogous shim-side rule; the page's own rule is `location.protocol ===
'file:'`, unconditionally, from `src/ui.mjs`) — the standalone archive stays network-free.

**Resync on every open** (additive; supersedes this section's earlier claim that a reconnect
"has missed nothing and needs no separate resync call"). That claim held only for a *daemon*
restart — nothing can mutate a board while the daemon is down — and does not follow for a
*client* disconnect, which is the common case: a sleeping laptop, a tab restored from the index
while the agent is mid-amend, a page served a moment before the round it is about to miss. The
stream carries no replay and the daemon emits no `id:` lines, so a broadcast that lands while a
client is disconnected is lost permanently, and the reviewer answers a round they cannot see the
whole of.

So on **every** `open` of the subscription — the first connection included — the client re-reads
the board and diffs it against its local copy with the same `computeBoardPatch` (`src/patch.mjs`)
every push uses, replaying the difference through the same apply path as a live push. A first
connection with nothing missed diffs to nothing and touches no DOM. The re-read is a plain
`GET /b/:boardId`: that page already inlines both the payload (`#board-data`, `resolveComment`
already run over it) and the server-rendered markup for every round, so the catch-up reuses the
exact fragments a live push would have carried rather than inventing its own. No new route is
required; a dedicated JSON route would be leaner and can be added later without changing this
rule.

## MCP surface

One tool, `ask`, on the stdio shim. It posts a board, opens the tab on the thread's first
board, and blocks on `/api/board/:id/wait`, emitting `notifications/progress` throughout so
the idle timer never fires. Arguments mirror the board document: `{ title, blocks }`, where
question blocks carry their questions by value and content blocks carry a `source` ref.

Failure is loud and writes nothing: an unreachable daemon returns the revive command, and a
non-interactive session is refused before anything is posted.

The shim tracks one thread per process (one shim per Claude session): the first `ask` call
starts a new thread and opens its tab; every later `ask` call in the same process pushes a
round into the same live board (`POST /api/board` with `boardId` set) and does not reopen
the tab.

### MCP shim environment (additive to `CLAUDE_BOARD_HOME` / `CLAUDE_BOARD_PORT` above)

```
CLAUDE_BOARD_TIMEOUT_MS       wall-clock cap on the blocking wait, default 2h (7_200_000)
CLAUDE_BOARD_PROGRESS_MS      notifications/progress cadence, default 20_000 (20s)
CLAUDE_BOARD_HEADLESS=1       forces the non-interactive refusal regardless of entrypoint
CLAUDE_BOARD_NO_OPEN=1        skip opening a tab at all (checks only; never set by a user)
CLAUDE_BOARD_OPEN_CMD         command used to open the board URL, default `open` (checks
                               override this to something other than a real browser)
CLAUDE_BOARD_POST_TIMEOUT_MS  timeout on POST /api/board only, default 10_000; never applied
                               to the /wait call, which must survive the full wall-clock cap
CLAUDE_BOARD_SECRET_FILE      where the local secret lives, default
                               ~/.config/claude-board/secret. Read by install.sh, the daemon
                               and the shim alike; a testing seam, not configuration
```

## Detecting a session with no human in it

Measured on Claude Code 2.1.220, not extrapolated: an interactive terminal session exports
`CLAUDE_CODE_ENTRYPOINT=cli`, while `claude -p` exports `CLAUDE_CODE_ENTRYPOINT=sdk-cli`.
Both export `CLAUDECODE=1`, so that variable discriminates nothing.

The shim therefore treats interactivity as an **allowlist and fails closed**: post only when
`CLAUDE_CODE_ENTRYPOINT` is one of `cli`, `vscode`, `jetbrains`, `ide`, `claude-desktop`,
`claude-desktop-3p`. Any other value — and an absent value — is a session with nobody
watching, and `ask` refuses before anything is posted or written. `CLAUDE_BOARD_HEADLESS=1`
forces the refusal regardless, which is the hook an unattended runner sets.

Known residual gap, deliberately not papered over: `/nightly` and `/loop` run *inside* an
interactive session, so the entrypoint still reads `cli` and no env check can see them. That
half of acceptance criterion 11 is a rule those commands must carry (set
`CLAUDE_BOARD_HEADLESS=1`, or do not call `ask`), not a mechanism the shim can enforce.

## Checks

`node test/run.mjs` runs all five checks — `check-pure`, `check-http`, `check-mcp`,
`check-install`, `check-grill` — and each is also runnable alone. No browser, no
network, no writes outside a temp `CLAUDE_BOARD_HOME`. Every check that touches the local
secret points `CLAUDE_BOARD_SECRET_FILE` at its own temp dir first: the real
`~/.config/claude-board/secret` is never read, written, or rotated by a check run.
