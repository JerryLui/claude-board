# Security

claude-board runs an always-on HTTP daemon as your login user and serves it pages
containing excerpts of your source files.

**Status: pre-release.** [Known and unclosed](#known-and-unclosed) and [what is
deliberately not defended](#not-defended-by-design) are both worth reading before
installing.

## Threat model

One human, one machine, one browser. Everything below assumes an attacker who is *not*
you and not on your machine, plus a partial defence against local software that is not
the daemon's own session.

**What is being protected**, in the order that matters:

- **The integrity of the reviewer's decision.** A submitted board is not a record; it is
  an input the agent then acts on. Everything else here is data, and this one is
  authority. Board content is agent-authored and untrusted, and it shares a screen with
  the controls that record an answer — so the invariant the rest of this document
  enforces is that **a stage may propose; it may never decide**. A forged submit is worse
  than a leaked board, because what gets counterfeited is the human's judgement.
- **Board content, and the source excerpts inside it.** A board embeds whatever it
  resolved, snapshotted at post time, plus every question, answer and comment. Reading a
  board is reading the code it quotes — including anything an allowlisted root can reach.
- **The daemon's TCC grants.** The bundle holds access to `~/Documents`, `~/Desktop` and
  `~/Downloads`. That is a capability the terminal-hosted agent does not itself have, so
  anything that can make the daemon read a file is spending the daemon's grants, not its
  own.

### Defended

#### The network

The daemon binds `127.0.0.1` only. Requests whose `Host` header is not
loopback are refused, which closes DNS rebinding: a page on any origin that resolves a
hostname it controls to `127.0.0.1` arrives with that hostname in `Host` and is rejected.

#### A web page you happen to be visiting

Cross-origin writes are refused by an origin check. A loopback `Host` check alone does
*not* stop a page doing `fetch('http://127.0.0.1:7391/…')`, because the browser sets a
loopback `Host` itself, and the bodyless POST routes — the pomodoro controls — are CORS simple
requests, so no preflight blocks them. The routes that take a JSON body are not reachable that way
in the first place: every body must be `application/json` (415 otherwise), which is not a simple
content type, so those always cost a preflight. The origin check is what stands in front of the
bodyless ones.

#### Another local process asking the daemon to read a file for you

Creating a board is the one route that resolves a path. Without a gate on it, any process that
could open a socket to the port could post a board naming any directory and read the result back
off the served page — with the daemon's privileges, not its own. So that route requires a local
secret, sent in a request header by the session's own MCP shim; the credential is what keeps "can
reach the port" from meaning "can spend the daemon's grants". `PROTOCOL.md` "The local secret"
carries the file's path, mode and generation.

Be precise about who that stops. It bounds callers that can reach loopback but **cannot
read your home directory** — a sandboxed process, a container publishing on host
loopback. It does **not** bound a process that TCC refused: TCC gates `~/Documents`,
`~/Desktop` and `~/Downloads`, not `~/.config`, so such a process reads the secret file
directly and then names whatever `cwd` it likes. Related: the shim presents the secret to
whatever holds `127.0.0.1:7391` without authenticating the peer first, so a process that
squats the port during a restart window is handed the credential it could not read.

#### What the launcher bundle is for

Those same three directories are why the plist runs
`~/Applications/claude-board.app` rather than `node` directly. TCC identifies an
application by its code signature and its enclosing bundle, so telling launchd to run the
interpreter would mean granting `~/Documents` to *every* node program on the machine — and
homebrew's node is ad-hoc signed under a versioned Cellar path, so `brew upgrade node` would
silently revoke that grant anyway. `install.sh` compiles `bin/launcher.c` into a bundle of
our own instead (ad-hoc signed, identifier `io.github.jerrylui.claude-board`): one
application, one folder, revocable on its own, listed under its own name. It forks node rather than exec'ing it, because TCC
decides against the responsible process and a child inherits its parent's.

The path the launcher runs is compiled in rather than read from the plist. If it ran
whatever the plist named, anything able to rewrite a file in `~/Library/LaunchAgents` —
which is to say any process running as you, including one TCC has refused — could spend
the bundle's grant on its own code.

#### The environment the daemon runs in

The launcher `execve`s with an environment it
constructs itself rather than passing its own through (`bin/launcher.c`, `OVERRIDE_ENV` /
`PASSTHROUGH_NAMES`). The four variables that decide what the daemon may read and
write — `HOME`, `PATH`, `CLAUDE_BOARD_HOME`, `CLAUDE_BOARD_REF_ROOTS` — are compiled in,
alongside `CLAUDE_BOARD_NODE`, `CLAUDE_BOARD_DAEMON` and `CLAUDE_BOARD_REPO_ROOT`. `PATH`
is baked fixed, since the daemon shells out to `osascript` and `open`. Only a short
allowlist of timing and port knobs is read from the plist, none of which can change what
directory the grant reaches. Everything else, `NODE_OPTIONS` and
`CLAUDE_BOARD_SECRET_FILE` included, is never placed in the child's environment at all —
and with `HOME` baked, `~/.config/claude-board/secret` is the only secret path the process
can reach. The two boundary variables are therefore **not** written into the plist when a
launcher bundle is in use, since a copy there would read as though rewriting the plist
could still move the boundary; a customised value is carried across reinstalls through a
record file in the 0700 directory beside the secret.

#### The build

`install.sh` compiles a *staged copy* of `bin/launcher.c` with `-iquote`,
inside the throwaway directory it generates `launcher_paths.h` into. Since a quoted
`#include` searches the including file's own directory first and no include path reaches
back into the clone, a `launcher_paths.h` planted next to `bin/launcher.c` cannot shadow
the generated one — structural, rather than a check that can rot. A leftover in the clone
still draws one non-fatal warning naming it.

#### The code the bundle runs

`bin/daemon.mjs` and the whole of `src/` are staged into
`claude-board.app/Contents/Resources` before the `codesign` call, so the ad-hoc signature
covers the payload's bytes at the moment it is made. **Nothing re-checks those bytes at
launch — see [Known and unclosed](#known-and-unclosed).** `bin/mcp.mjs` and
`bin/authorize.mjs` are deliberately not copied: they are the shim, invoked at the clone's
own absolute path, never under the TCC-granted identity. The rebuild stamp
(`~/.config/claude-board/launcher.stamp`) folds in a
content-only digest of that payload, so a reinstall that changed nothing rebuilds nothing
and an already-granted user is never re-prompted by a routine `git pull && ./install.sh`.
The digest refuses any non-regular file outright and the staging copy dereferences with
`cp -RL`, so the digest and the signed payload describe the same bytes.

The clone is a build input, not a live execution path: a `git pull` alone changes nothing
about what is running until `install.sh` runs again, and a bare `launchctl kickstart` no
longer picks up a source edit (QUIRKS.md). There is no auto-update and nothing checks for
one, so pulling and reinstalling a security fix is the reader's job, not the daemon's.

**Known limits of that:**

- **A rebuild costs the grant, on purpose.** Every value that decides what the daemon may
  read or write is an input to the bundle's own bytes, so changing any of them
  changes the cdhash and macOS re-prompts for Documents access on the next launch. That is
  the design working — the alternative is a boundary a rewritable plist could move without
  a rebuild — but a user meets it as friction: retargeting `CLAUDE_BOARD_REF_ROOTS`, or
  editing anything under `src/`, costs a fresh TCC prompt.
- **Whoever can write the clone owns the *next* install, not the running daemon.**
  `install.sh` builds the launcher and its payload from the clone, so a poisoned clone
  followed by a reinstall lands inside the signature. It cannot do so silently — the
  poisoned bundle carries a different cdhash than the one already granted, so the
  reinstall re-prompts, and an attacker who cannot click through that prompt gets nothing.
  Treat the clone directory and the LaunchAgents plist as inside the trust boundary.

#### Where a reference can reach

A reference resolves in exactly two places: inside the
board's own project directory, or inside the reference allowlist —
`CLAUDE_BOARD_REF_ROOTS`, colon-separated absolute paths. Anywhere else is refused, as a
visible error on the block rather than a silent empty read. `PROTOCOL.md` carries the
enumerated rules — what is refused, in what order, and on what. What matters here is that
every path is resolved through `realpath` before it is checked, so `../` traversal and a
symlink aimed out of the project or out of a root are refused alike; that `/`, `$HOME` and
anything above `$HOME` are never usable as roots; and that a root or a spec that fails
validation is dropped rather than widened, so a malformed `CLAUDE_BOARD_REF_ROOTS` grants
nothing rather than granting a neighbouring directory nobody named.

#### What the default allowlist is

`~/.claude/skills`, `~/.claude/commands`,
`~/.claude/agents` and `~/Documents/renders`. Under `~/.claude` that is three directories,
not the whole of it, which also holds `.credentials.json`, `settings.json`, shell
snapshots and every project's transcripts. The fourth is the render directory the render
skills already write into, so a page an agent just rendered can be posted by reference
rather than pasted in by value. Every default root is a directory only this user writes
to: a world-writable one (`/tmp`) is deliberately not a default, since a default reaches
every install on the next upgrade and a reference root is read on an agent's say-so. Name
it yourself if you want it. An *absent* `CLAUDE_BOARD_REF_ROOTS` means the project
directory alone. The default lives in `install.sh` rather than in the daemon's code, so
the boundary only ever widens during an install that prints the roots it resolved. A value
you narrowed once is carried forward across an upgrade, but not frozen: any directory the
*current* defaults name that your carried-forward record is missing is added back in on the
next install and named on screen (`ADR.md` entry 36) — a record predating
`~/Documents/renders` is exactly the case that forced this. Narrowing a directory the
defaults do not name still survives indefinitely; keeping the list genuinely short now
takes reasserting `CLAUDE_BOARD_REF_ROOTS` explicitly rather than trusting the record's
inertia.

The allowlist is wider than a project-directory-only boundary (`ADR.md` entry 3):
resolving a reference is only ever a read, and a session that could never show you the
skill or command file it was discussing was the case that forced it. The cost is worth
stating plainly. A board embeds what it resolves, so anything under an allowlisted root
can end up quoted into a board and readable by anyone holding the session credential — the
allowlist is the set of directories you are willing to have quoted. Neither the daemon nor
a reference ever writes to any of it.

#### The file that is checked is the file that is read

A path is a name, not a thing:
checking a name and then re-opening it is two lookups with a gap, and anything that can
write inside an allowlisted root can change what the name means during that gap. So a
reference is opened exactly once, refusing to follow a symlink in any component while it
does, and every later question — regular file, under the cap, what are its bytes — is
asked of that one descriptor rather than of the name again.

#### Another local process reading your boards, or forging an answer on one

Every route but `GET /api/health` and `GET /auth/<token>` requires a credential — the index, a board
page, archive search, the blocking wait and the event stream alike. (`/auth/<token>` is
the route that *hands out* the credential, so it cannot require one; it is protected by
the token being unguessable, single-use and seconds-lived.) There are exactly two
credentials: the secret file above, and a cookie the daemon derives from it and hands to
your browser through that single-use handoff. **The cookie has a caveat worth reading
before you rely on it — see "Any other HTTP server on your machine" under [Known and
unclosed](#known-and-unclosed).** Nothing you can bookmark carries a credential. If a
browser ends up holding nothing — cleared cookies, a second profile, a different browser —
the refusal page names one command that fixes it: `node bin/authorize.mjs` from your clone.

#### What the cookie may write

The secret authorizes every write; the cookie authorizes a strictly smaller, closed set,
enumerated in `PROTOCOL.md` "The browser session cookie". Three named lists carry it —
`BOARD_COOKIE_ACTIONS`, `POMODORO_COOKIE_ACTIONS` and `STORE_COOKIE_ACTIONS`, all in
`src/server.mjs` — and that they are named lists rather than an `/api/<thing>/*` prefix match is
what keeps a route added later secret-only until someone widens it deliberately. The set reaches
further than the name suggests: a browser holding only the cookie drives the whole pomodoro clock
— every duration along with both the notify and the round-banner toggles — reports a board
Attended or not, and prunes the store.

The `attended` report and the round-banner toggle are why each of them has to be authenticated at
all, and they are not the same
size. A forged `attended` report silences the Stranded banner for one board, in memory, until the
daemon restarts. The round-banner toggle is the larger one: `notifyRounds: false` through
`settings` is merged into the stored settings and persisted, and the daemon reads it back on every
announcement, so one write durably silences **every** Stranded banner for **every** board on the
machine, across restarts, without touching a board or the secret file (ADR.md entry 58). The
same-origin write check stands in front of all of it.

#### `prune` is the one cookie-reachable write that destroys something

It is on the list with its eyes open (ADR 71). `POST /api/store/prune` deletes every board older than
a window the request names, documents and emitted pages together, plus any shared asset
no surviving page still references. It is admitted not because it reaches less than
`submit` — it reaches further — but because the control that fires it lives in the index
page's settings panel, and that page is exactly a browser holding only the cookie;
requiring the secret would make the one surface the design names unable to use it. What
still stands in front of it is the rest of the gate: loopback `Host`, the same-origin
write check, and a cookie derived from the local secret that rotating the secret revokes.
The same holder can already read every question, answer and snapshotted source file in
the archive, so this is not a credential the archive was being protected from. There is
no automatic prune anywhere — nothing sweeps on read, at daemon start or on a timer — so
nothing deletes a board unless someone clicks.

#### Guessing a board URL

Board ids are 16 random bytes — but that entropy is not what
protects the board. Every route requires a credential, reads included, so a guessed id
buys a refusal rather than a page. The id's unguessability is defence in depth behind that
gate, never the gate itself; nothing you can bookmark carries a credential.

#### Content injection through rendered material

Markdown, code and file content is escaped
in both HTML text and attribute positions. Since `ADR.md` entry 62 that content passes
through two vendored third-party engines first — `marked` tokenizes markdown, `prismjs`
tokenizes code — but neither is trusted to emit anything: both are used as *tokenizers*
only, and `src/markdown.mjs` and `src/render.mjs` walk the resulting token trees and do
every escape themselves, exactly as they did before a parser was vendored. Raw HTML in a
markdown source file therefore still renders as text, never as markup. The engines are
pinned by sha256 with an offline digest check, so the bytes that run are the bytes that
were reviewed. HTML stages render inside an iframe with
`sandbox="allow-scripts"` and no `allow-same-origin`, so the stage's browsing context is
cross-origin from the daemon's own and `contentDocument`/`contentWindow` are unreachable
from the parent; an isolation check asserts the parent ignores hostile messages that carry
a correct origin. `html` is the one kind whose `source` may name a file rather than only
carrying markup by value (`ADR.md` entry 7), and it gets no extra footing for it: whether
the markup was typed into the request body or read off disk by the daemon, it is
agent-authored and untrusted either way.

#### The agent answering its own question

The `choose-between-rendered-variants` widget
puts a rendered block inside each option, and that block may be an HTML stage — an iframe
running script the *agent* wrote, sitting inside the control the *reviewer* uses to decide.
So the stage is given no way to reach that decision: inside an option's card the iframe is
`pointer-events: none`, the selecting click lands on the card in the parent document, and
no stage-to-parent message can select anything. The distinction this rests on is the one
that is easy to lose: validating a message's origin and re-deriving its frame from the live
DOM proves only that *a stage* sent it, never that *a human* did. A stage may propose (mint
a comment); it may never decide.

#### Your review content at rest

The store and the daemon logs are owner-only (0700); the
logs carry your own questions and answers, so they get the same posture as the store.

### Known and unclosed

Real holes, not chosen ones. Nothing below is defended today; each is here because a
reader deciding whether to install should price it.

**The payload is signed at install time and unverified at launch.** `bin/launcher.c`
`execve`s node against `Contents/Resources/bin/daemon.mjs` and checks nothing about it
first; `codesign --verify` runs only when a human re-runs `install.sh`. Those Resources
files are writable by you, and TCC matches the *main executable's* cdhash alone — so
editing one leaves the cdhash unchanged, triggers no re-prompt, and the edited code runs
under the grant the original earned. The signature is a build-time record, not a runtime
gate. A payload digest compiled into the launcher and checked before `execve` would close
this; it is **not implemented, and not planned** — the risk is accepted as it stands.
Do not read it as a fix in progress.

**`DYLD_INSERT_LIBRARIES` on the launcher's own load is untouched by any of this.** The
`execve`-built environment governs what the launcher hands *node*; it has no say over
what launchd hands the *launcher*, one hop earlier, because dyld reads its own family of
variables while loading the launcher's image, before a line of `main()` runs (QUIRKS.md).
Closing this needs hardened-runtime signing (`codesign --options runtime`), which carries
its own entitlement and TCC consequences.

**Any other HTTP server on your machine, whatever port it listens on.** Cookies are not
scoped by port (RFC 6265 §8.5) and `SameSite` is not port-aware — a "site" is a scheme plus
a host, so every port on `127.0.0.1` is the same site. If you authorize a board and then
visit `http://127.0.0.1:3000` in the same browser — your own dev server, a notebook kernel,
a container you published on loopback — that server receives the `cb_session` cookie on a
plain navigation, and can replay it here to read every board, answer any open round, and — via
`POST /api/pomodoro/settings` with `notifyRounds: false` — durably switch off every Stranded
banner on the machine, which is the whole notification safety net that feature exists to be. It
never touches the secret file, so this sits *outside* the "any process running as you"
boundary further down: a container that cannot read your home directory can still do it.

Nothing here closes it. The daemon cannot tell a replay from the browser it minted the
cookie for, and while the index lives at `/` on `127.0.0.1` the cookie is scoped to every
port on that host. Cookies *are* scoped by host, so serving boards from a name of their
own (`isLoopbackHost` already admits `*.localhost`) would scope `cb_session` away from
`127.0.0.1:3000` — at the price of an `/etc/hosts` line on Safari and broken bookmarked
board URLs. That has not been done. What is done instead is bounding it:

- **there is no expiry bound worth relying on.** The cookie's value is
  `HMAC(secret, "claude-board/session/v1")` — a constant with no timestamp in it — and
  `SESSION_MAX_AGE_S` appears only as a `Set-Cookie` attribute, which instructs an honest
  browser's jar and constrains nothing about a value already copied out of it. A leaked
  cookie stays valid until the secret is rotated, and the secret is never rotated
  automatically;
- a cookie-authenticated request must also look same-origin (`Origin` / `Sec-Fetch-Site`),
  which stops a *web page* on another origin using it through your browser. It does not
  stop the case above, because a local process sets its own headers;
- rotating the secret revokes every cookie on the next *request* — the daemon re-reads the
  secret per request rather than at startup. It does **not** close connections already
  open: the read gate is evaluated once, when a request starts, so an SSE stream
  (`/api/board/:id/events`) established before the rotation keeps receiving every later
  round and every submitted answer for that board, and an in-flight `/wait` still returns
  its packet. Both last until the daemon restarts. If you are rotating because a cookie
  leaked, restart the daemon too — `launchctl kickstart -k gui/$(id -u)/claude-board`.

If you run other services on loopback and this matters to you, use a separate browser
profile for boards.

**Third-party code executing in the board's own origin.** A board with a diagram on it
does `await import('https://cdn.jsdelivr.net/npm/mermaid@11.16.1/dist/mermaid.esm.min.mjs')`
(`src/ui.mjs`), which is why `script-src` names a host nobody here controls
(`src/render.mjs`, `src/server.mjs`). Unlike a referenced `html` stage, that module does
not land in a sandboxed opaque-origin iframe — it runs in the board page itself, where
`#board-data` holds every answer and every comment and `connect-src 'self'` is the ability
to POST a submit under the session cookie. The version is pinned exactly and both
`script-src` allowlists name that version-pinned path rather than the bare host, so an
upstream 11.x publish cannot change what runs and no other version can be pulled from the
same origin. What remains: dynamic `import()` takes no `integrity` attribute, so there
is no hash — anything that can serve different bytes *at that path* gets read-every-board
plus forge-an-answer, on every board rendered after it. Closing it means vendoring mermaid
into the signed payload and dropping the host from the CSP. The availability consequence —
boards render fine without network, diagrams do not — is the smaller half of it.

`script-src` and `style-src` also carry `'self'` since ADR 70, because a page now names its
script and stylesheet instead of inlining them. That admits exactly one route,
`GET /b/<name>`, which serves nothing but a file in `pages/` whose name matches
`(ui|styles)-<16 hex>.(js|css)` — an anchored pattern, checked where the name becomes a path
(`src/store.mjs`), so no name off the wire can escape that directory or reach anything else
in it. Planting a script there needs write access to the store, which is the
running-as-you boundary directly below. `'self'` is deliberately not widened to a bare
`file:` source, which would also make an archive work but would let an archived board's
untrusted `html` stage — it inherits the page's policy through its `srcdoc` — pull any
script off the reader's disk.

### Not defended, by design

**Any process running as you.** It can read `~/.config/claude-board/secret` and is
therefore fully trusted by the daemon — it can read every board, answer any of them, and
mint itself a browser credential. This is not fixable at this layer: it is the same posture
as an ssh private key or a shell profile, and every gate above is built on that file
staying yours.

**A hard link into an allowlisted reference root.** The reference boundary is enforced on
`realpath`, which resolves symlinks and is therefore blind to hard links — a hard link is
not a pointer to a file, it is a second, equally real name for the same inode, and nothing
in the filesystem marks one of the two as the original. So `ln ~/Documents/private.md
~/.claude/skills/x.md` puts a file nowhere near an allowlisted root at a path that is, and
a board can then quote it. The one candidate fix — refusing any file with a link count
above one — was rejected because it refuses legitimately hard-linked content
(content-addressed stores, `cp -l`, some backup tools) and there is no test that separates
the two cases. Anything that can create such a link is running as you, and so is already
inside the boundary directly above.

The same escape has a larger consequence for one kind: for `markdown`, `code` and
`mermaid`, "quote it" means the hard-linked file's bytes appear as escaped text or a fenced
diagram. For `html`, quoting it means its markup is what runs inside the sandboxed stage —
still opaque-origin, still under the page CSP, so not a new hole, but a bigger one to fall
into by the same route.

**A browser extension with host permissions on the profile holding the credential.** It can
read boards and submit as you. `HttpOnly` stops page script, not extensions.

**A process watching `ps` at the instant a tab opens.** Opening a URL puts it in an argument
list, so the handoff token is briefly visible to any process running as you. The mitigation
is that the handoff is single-use and lives for seconds: a watcher has to be polling
continuously *and* win the race against the browser already fetching it, and if it loses it
learns nothing — an already-used token is refused exactly like an expired or invented one.
That is a narrow race, not an eliminated one. It is also inside the boundary above: such a
process could read the secret file instead.

**An archived board.** `pages/<boardId>.html` opens from disk with no credential at all,
with the two shared files beside it (ADR 70); the gate is on the daemon, not on the
archive. Anything that can read that directory can read those boards, which is the same
statement as "the store is owner-only" above.

**Anything multi-user or remote.** There is no authentication, no accounts, no
cross-machine access, and none is planned. Do not expose the port.

**What a board file contains.** Treat the store as you would treat the repository it
quotes, and the allowlisted roots it may also quote.

## How this record is kept

**This file** carries the current posture; **[ADR.md](ADR.md)** and git history carry the
reasoning behind it. Nothing has been released yet, so
there is no per-release security note to keep; `git log` carries the fixes until there is
a tag. The internal review reports behind them stay unpublished: a per-commit adversarial
audit of a pre-release codebase would be a second, staler security narrative beside this
one.

## Reporting

Open a GitHub issue for anything that is not itself exploitable, or use GitHub's private
vulnerability reporting for anything that is. This is a personal project with no support
commitment and no response-time promise.
