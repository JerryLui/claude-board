# Architecture Decision Record

## Index

| # | Decision | Date | Status |
|---|---|---|---|
| 1 | Theme selection is client-side only | 2026-07-30 | accepted |
| 2 | Comments are deletable only before Send | 2026-07-30 | accepted (see *Smaller decisions*) |
| 3 | References resolve inside a configured allowlist, not only `cwd` | 2026-07-30 | accepted |
| 4 | Every command falls back off the board, `/grill` included | 2026-07-31 | accepted; **narrowed by 55** |
| 5 | This repo ships the protocol, not its callers | 2026-07-31 | accepted; weakened by 11 |
| 6 | Commenting is confined to content blocks | 2026-08-01 | accepted; **narrowed by 28** |
| 7 | An `html` block may name a file, but only a whole one | 2026-08-04 | accepted |
| 8 | The daemon owns the pomodoro clock | 2026-08-04 | accepted |
| 9 | No menu bar item — the bundle's signature is load-bearing | 2026-08-04 | accepted; **narrowed by 57** |
| 10 | The daemon serves a rendered file, it does not render one | 2026-08-04 | **superseded by 38** |
| 11 | The repo ships one caller-facing file: the manual | 2026-08-04 | accepted; weakens 5 |
| 12 | The mark is amber | 2026-08-04 | accepted; **inversion half superseded by 30** |
| 13 | The daemon's environment is baked into the launcher, not the plist | 2026-08-04 | accepted |
| 14 | The launcher is compiled from a staged copy; the stamp covers the binary | 2026-08-04 | accepted |
| 15 | The daemon's own code is staged into the signed bundle | 2026-08-04 | accepted |
| 16 | The index search box filters sessions; it does not search inside them | 2026-08-04 | accepted (see *Smaller decisions*) |
| 17 | The pomodoro switch may start a timer, so the cookie may call `ensure` | 2026-08-04 | accepted (see *Smaller decisions*) |
| 18 | The boundary cue is played, not attached to the notification | 2026-08-05 | **superseded by 20** |
| 19 | The pomodoro notification is posted by the bundle, not by osascript | 2026-08-05 | accepted; **narrowed by 56** |
| 20 | The cue is a bare name, so macOS owns the cue | 2026-08-05 | accepted; supersedes 18 |
| 21 | The per-stage comment hint is deleted | 2026-08-05 | accepted (see *Smaller decisions*); **narrowed by 48** |
| 22 | The stage lens may record a pick | 2026-08-05 | accepted |
| 23 | The cue picker reads `~/Library/Sounds` as well | 2026-08-05 | accepted; extends 20 |
| 24 | Forward is the boundary made early, and it is silent | 2026-08-05 | accepted (see *Smaller decisions*) |
| 25 | The index badge counts open rounds, not pending questions | 2026-08-06 | accepted (see *Smaller decisions*) |
| 26 | A question's context is prose under the prompt | 2026-08-06 | accepted; **comment half superseded by 28** |
| 27 | A live unanswered count floats beside the send guard | 2026-08-06 | accepted (see *Smaller decisions*) |
| 28 | Only the rendered kinds can be commented on | 2026-08-06 | accepted; supersedes the comment half of 26, narrows 6 |
| 29 | `Cmd+Enter` sends a finished round on arrival | 2026-08-06 | accepted (see *Smaller decisions*) |
| 30 | The tab mark stays amber; a numeral replaces the inverted tile | 2026-08-06 | accepted; supersedes 12 |
| 31 | The rest tile's colour gets its own token | 2026-08-06 | accepted (see *Smaller decisions*) |
| 32 | A rendered page reaches the board as a snapshotted stage, not a framed served file | 2026-08-07 | accepted |
| 33 | Fullpage is inferred from the board's shape, not declared by the caller | 2026-08-07 | accepted |
| 34 | A page board's stage fills the viewport rather than growing to its content | 2026-08-07 | accepted (see *Smaller decisions*) |
| 35 | An undelivered comment rides the thread's next packet | 2026-08-07 | accepted; narrowed by 45, 46 |
| 36 | An upgrade widens a carried-forward root record back to the current defaults | 2026-08-07 | accepted |
| 37 | The renderer templates pin the mermaid CDN fallback and keep the vendored copy | 2026-08-07 | accepted (see *Smaller decisions*) |
| 38 | `/file/` is deleted; the board is the only way to see a rendered page | 2026-08-07 | accepted; supersedes 10 |
| 39 | The board pushes its theme into the stage | 2026-08-07 | accepted (see *Smaller decisions*) |
| 40 | The page board header condenses into a centred pill on reading | 2026-08-07 | accepted; **corrected by 49**; **narrowed by 59**; **widened by 60** |
| 41 | A reported stage height is floored at the placeholder, not only capped | 2026-08-07 | accepted (see *Smaller decisions*) |
| 42 | Rounds are the board's pages, flipped left and right | 2026-08-07 | accepted; **narrowed by 61** |
| 43 | A page board carries no expand control | 2026-08-07 | accepted (see *Smaller decisions*) |
| 44 | "A page board is never sent" is a browser rule, not a daemon rule | 2026-08-07 | accepted |
| 45 | A page board may be awaited, and the caller declares it | 2026-08-07 | accepted; narrows 35; completed by 50 |
| 46 | Commenting exists only where someone is waiting | 2026-08-07 | accepted; narrows 35 |
| 47 | The wait is 40 minutes, for every round, and the page shows what is left | 2026-08-07 | accepted |
| 48 | The click-to-comment hint returns, in exactly one place | 2026-08-08 | accepted; narrows 21 |
| 49 | The page board's pill may hold a label alone | 2026-08-08 | accepted; corrects 40 |
| 50 | A wait that dies is recorded on the round | 2026-08-08 | accepted; completes 45 |
| 51 | The docked send bar draws no hairline | 2026-08-08 | accepted (see *Smaller decisions*) |
| 52 | A header that fades draws no border under the fade | 2026-08-08 | accepted (see *Smaller decisions*) |
| 55 | A stranded round is announced, not opened onto | 2026-08-09 | accepted; narrows 4; widened by 58 |
| 56 | The launcher may compose a notification body, behind a filter | 2026-08-09 | accepted; narrows 19 |
| 57 | The banner opens the board it names | 2026-08-09 | accepted; narrows 9 |
| 58 | One notifier for a round, and it is the daemon's | 2026-08-09 | accepted; widens 55 |
| 59 | The board clears its own chrome band, the artifact does not | 2026-08-09 | accepted; narrows 40 |
| 60 | The condense is every board's, not the page board's | 2026-08-09 | accepted; widens 40 |
| 61 | The header stops naming the round | 2026-08-09 | accepted; narrows 42 |

Entries 32-43 come from the page-board grill and are built, with one part-exception: 37 lives in
the renderer skills under `~/.claude/skills`, outside this repo, so only its board-side half (the
CSP pin) is here. Entries 45-49 come from the awaited-page-board grill and are built; entry 50
completes 45 with the half it was missing. `SPEC_AWAITED.md` carries their per-criterion state.

Rejected alternatives and the reasoning behind an entry live in `DESIGN.md`, which the entries
below link where it is worth reading.

## Smaller decisions

Settled without a rejected alternative anyone would plausibly have taken, so recorded
in a line rather than argued at length.

| # | Decision | Date | Status |
|---|---|---|---|
| 2 | Delete and edit reach only comments still in `pendingComments`; `board.comments` is append-only. | 2026-07-30 | accepted |
| 16 | The index search box filters the thread list; `GET /api/search` stays the only full-text surface. | 2026-08-04 | accepted |
| 17 | `ensure` joins `POMODORO_COOKIE_ACTIONS`, which stays a closed named list rather than a prefix match. | 2026-08-04 | accepted |
| 21 | `stageHint` is deleted on both stage kinds; the comment-mode toggle carries discoverability alone. | 2026-08-05 | accepted; **narrowed by 48** |
| 24 | Forward applies the natural advance rule at click time and fires no notification and no cue. | 2026-08-05 | accepted |
| 25 | The index badge counts open rounds still asking something (`N rounds left`), hidden at zero. | 2026-08-06 | accepted |
| 27 | A grey pill above the send bar names the unanswered count and jumps to the first; it does not touch the guard. | 2026-08-06 | accepted |
| 29 | Arriving at Send with nothing outstanding submits; otherwise the click guard arms. `armSend` is deleted, leaving one armed state. | 2026-08-06 | accepted |
| 31 | The rest tile mints `--mark-rest-tile` instead of reading `--scrollbar-hover`, so a scrollbar restyle cannot move the tab mark. | 2026-08-06 | accepted |
| 34 | A page board's stage is a constant `100vh` box scrolling internally, because the rendered templates use `position: sticky` and their own full-viewport `<dialog>`. | 2026-08-07 | accepted |
| 37 | The renderer templates pin the mermaid CDN fallback to the version the board CSP names and keep the vendored `assets/` copy, which still answers when a page is opened from Finder. | 2026-08-07 | accepted |
| 39 | The board pushes its theme into the stage over the channel that already carries comment mode, and the renderer templates drop their own corner toggle. | 2026-08-07 | accepted |
| 41 | `handleStageHeight` gains a floor at the 320px placeholder beside its 600px cap, so a stage that sizes itself from the viewport cannot lock its card at the collapsed height it reports. | 2026-08-07 | accepted |
| 43 | A page board's stage carries no expand control, because the lens it opens is a copy of what already fills the viewport. | 2026-08-07 | accepted |
| 51 | The docked send bar draws no hairline of its own: `.docked` means the closing rail is on screen, and that rail is already a full-width line two rows above it. | 2026-08-08 | accepted |
| 52 | A header that fades draws no border under the fade: the gradient is the edge, on the ordinary board head and on the page board's wash alike. | 2026-08-08 | accepted |

## 1. Theme selection is client-side only — 2026-07-30
**Status:** accepted
**Context:** a server-read theme cookie would break the asserted byte-identity of the served page and its `pages/*.html` archive. **Decision:** the theme is chosen entirely in the browser — media query default, `localStorage` override, applied by an inline script before first paint. **Consequences:** the preference is scoped to scheme+host+port, and `src/theme.mjs` gates every storage access on `location.protocol !== 'file:'` so an archive reads no `file://`-wide preference.

## 3. References resolve inside a configured allowlist, not only `cwd` — 2026-07-30
**Status:** accepted
**Context:** confining every reference to the board's `cwd` meant a session could never render the skill or command file it was discussing. **Decision:** references resolve under `cwd` or `CLAUDE_BOARD_REF_ROOTS`, defaulted in `install.sh` so that running the installer is the consent event. **Consequences:** widens the corpus reachable by anyone holding the session cookie, and a hard link into a root stays undefended by design (SECURITY.md).

## 4. Every command falls back off the board, `/grill` included — 2026-07-31
**Status:** accepted; narrowed by 55
**Context:** the shim refused a non-interactive session by design, which made every migrated command unusable headless. **Decision:** every command carries a non-board path and announces taking it, on three triggers — the daemon is unreachable, the session is headless, or no tab opens. **Consequences:** a broken board can go unnoticed behind a degraded path that keeps working, and `/grill` alone loses its artifact.

## 5. This repo ships the protocol, not its callers — 2026-07-31
**Status:** accepted
**Context:** `install.sh` shipped `commands/grill.md` from when `/grill` was the only caller, and five more callers then appeared that this repo never wrote. **Decision:** the repo ships the daemon, the shim, the protocol and the prose checker, and no callers. **Consequences:** callers stop tracking this repo's release cycle but now import a path inside it.

## 6. Commenting is confined to content blocks — 2026-08-01
**Status:** accepted; narrowed by 28
**Context:** `question` and `compare` render no content of their own, so a comment anchored to either names nothing the agent can act on. **Decision:** content kinds keep the button and the click-to-anchor gesture, wrapper kinds lose both, and nested blocks keep theirs. **Consequences:** comments already stored against wrapper kinds in archived boards are not a supported case.

## 7. An `html` block may name a file, but only a whole one — 2026-08-04
**Status:** accepted
**Context:** an 80 KB rendered page could reach a board only as ~25-30K generated tokens, a price an agent silently declined to pay, posting a stub instead. **Decision:** `html` accepts `source: { path }` through the same reader, confinement, cap and error behaviour as every other kind, refusing `lines` and `section` because markup does not survive slicing. **Consequences:** `html` becomes the only path-only ref, and a referenced file executes in the stage on exactly the footing an inline mock does (SECURITY.md).

## 8. The daemon owns the pomodoro clock — 2026-08-04
**Status:** accepted
**Context:** entry 1 put preferences in the browser and that held for every setting since, but a timer you lose by closing a tab is not a timer. **Decision:** the daemon persists the interval's absolute deadline, the cycle counter and the durations; the browser only renders a countdown from that deadline. **Consequences:** entry 1's principle now needs its boundary stated — a theme is a per-reader preference, a pomodoro is one fact about the human.

## 9. No menu bar item — the bundle's signature is load-bearing — 2026-08-04
**Status:** accepted; narrowed by 57
**Context:** a menu bar countdown looks nearly free in an always-on tool that already ships a macOS app bundle. **Decision:** no `NSStatusItem` and no AppKit in `bin/launcher.c`; the pomodoro surfaces are a boundary notification and an index widget. **Consequences:** the always-visible glance is given up rather than re-sign gratuitously and risk the TCC Documents grant; a second dedicated bundle is the shape to revisit.

## 10. The daemon serves a rendered file, it does not render one — 2026-08-04
**Status:** superseded by 38
**Context:** a posted absolute path is not clickable — markdown allows only `http(s)` and `mailto`, and no browser navigates from `http://127.0.0.1` to `file://`. **Decision:** `GET /file/<path>` streams bytes from `CLAUDE_BOARD_SERVE_ROOTS`, its own allowlist, with no wrapping, slicing, capping or directory listing.

## 11. The repo ships one caller-facing file: the manual — 2026-08-04
**Status:** accepted
**Context:** six callers outside this repo each restated how to call `ask` — 148 lines, already drifted on widgets, recovery command and `html` refs. **Decision:** `skills/claude-board/SKILL.md` ships from here and `install.sh` copies it unconditionally. **Consequences:** entry 5's boundary weakens to "one file, and we authored it", and in exchange `test/check-skill-prose.mjs` binds prose to mechanism in the shim's own repo.

## 12. The mark is amber — 2026-08-04
**Status:** accepted; inversion half superseded by 30
**Context:** a favicon gets no CSS and no useful `prefers-color-scheme`, and `--accent`'s two theme values sit too far apart for one tile to serve both tab strips. **Decision:** the mark takes `DARK['--warning']`, the one hue this palette carries at nearly the same value in either theme. **Consequences:** the brand permanently shares a hue with a state colour, so a `--warning` retune moves it silently, and the explicit `DARK` naming must survive since light's `#805300` renders as mud.

## 13. The daemon's environment is baked into the launcher, not the plist — 2026-08-04
**Status:** accepted
**Context:** the plist is mode 644 and user-writable, so a `NODE_OPTIONS=--require` key ran arbitrary code inside the TCC-granted process with the signature untouched. **Decision:** `bin/launcher.c` `execve`s an environment it constructs itself — five variables compiled in via `launcher_paths.h`, six named ones passed through, and nothing else placed there at all. **Consequences:** retargeting a root now costs a rebuild, a re-sign and a TCC re-approval.

## 14. The launcher is compiled from a staged copy; the stamp covers the binary — 2026-08-04
**Status:** accepted
**Context:** a quoted `#include` searches its own directory first, so a `launcher_paths.h` dropped into `bin/` shadowed the generated header and was signed into the granted bundle, invisibly in `git status`. **Decision:** `install.sh` compiles a staged copy with `-iquote`, warning non-fatally about a header left in the clone, and the stamp gains the sha256 of the installed executable. **Consequences:** identical inputs still report "already current", so the TCC grant survives a routine reinstall.

## 15. The daemon's own code is staged into the signed bundle — 2026-08-04
**Status:** accepted
**Context:** the trustworthy launcher of entries 13 and 14 still forked node against `bin/daemon.mjs` and `src/` sitting unsigned and user-writable in the clone, so an edit took effect under the granted identity. **Decision:** `install.sh` stages both into `Contents/Resources` before `codesign`, and a deterministic payload digest joins the stamp. **Consequences:** the clone becomes a build input, so a bare `kickstart` no longer picks up a source edit.

## 18. The boundary cue is played, not attached to the notification — 2026-08-05
**Status:** superseded by 20
**Context:** `UNNotificationSound soundNamed:` resolves against the bundle's own Resources, so a per-phase cue would have collapsed to one generic sound on the bundled install. **Decision:** the daemon plays the cue itself with `afplay /System/Library/Sounds/<Name>.aiff` and posts every notification silent on both paths.

## 19. The pomodoro notification is posted by the bundle, not by osascript — 2026-08-05
**Status:** accepted; narrowed by 56
**Context:** a notification's name, icon and System Settings row all come from the posting process's bundle, so `osascript` gave the pomodoro Script Editor's identity. **Decision:** `bin/notify.m` compiles into the launcher, which gains a `--notify <phase>` mode; `osascript` stays only for the bundle-less install. **Consequences:** the reader can set Alerts on claude-board's own row, paid for with a launcher that reads argv and one more permission prompt at install time.

## 20. The cue is a bare name, so macOS owns the cue — 2026-08-05
**Status:** accepted, supersedes 18
**Context:** a cue the daemon plays is not a notification, so no Focus, per-app toggle or notification switch can silence it. **Decision:** the cue is a bare name resolved where it already lives — `soundNamed:` on the bundled path, AppleScript's `sound name` on the clone path, the same names either way. **Consequences:** every macOS notification control reaches the cue, and `src/cues.mjs` enumerates the directory macOS resolves against, so there are not two lists to keep in sync. Rejected alternatives: DESIGN.md; the staging measurement: QUIRKS.md.

## 22. The stage lens may record a pick — 2026-08-05
**Status:** accepted
**Context:** a variant option's stage is inert so that only a real reviewer click can record a pick, and the lens added for readable size makes that same stage live. **Decision:** the lens carries a control that picks the option it was opened from and closes in the same act, naming that option in chrome outside the framed stage. **Consequences:** the residual risk is a mock drawing convincing fake chrome rather than the stage pressing anything (`test/check-stage-isolation.mjs`).

## 23. The cue picker reads `~/Library/Sounds` as well — 2026-08-05
**Status:** accepted, extends 20
**Context:** the stock 14 are the only cues on offer, and a reader who wants a gong has nowhere to put one that entry 20 permits. **Decision:** `SOUNDS_DIRS` holds both directories, unioned by `cueNames()` and walked by `cuePath()` in the order QUIRKS.md measures macOS to prefer; the daemon still writes nothing. **Consequences:** the `cueNames()` memo gains a 5s TTL, and a name present in both directories resolves to the system copy, so a reader who shadows a stock sound never hears their file.

## 26. A question's context is prose under the prompt — 2026-08-06
**Status:** accepted; comment half superseded by 28
**Context:** `.question-block` split into two columns whenever a question carried context, rendering a `choose-between-rendered-variants` question's stages at half the column, on a round the reviewer could not answer. **Decision:** a question carrying a rendered stage lays out full width, and context stacks under the prompt as plain prose with no card, no kicker and no comment control. **Consequences:** context cannot be pointed at in a comment; feedback on it goes in the question's own note.

## 28. Only the rendered kinds can be commented on — 2026-08-06
**Status:** accepted, supersedes the comment half of 26 and narrows 6
**Context:** entry 6 drew the rule on wrapper versus content and entry 26 then narrowed it by position, but the reviewer comments on rendered output and never on prose or code. **Decision:** the comment button and click-to-anchor belong to `html` and `mermaid` wherever they appear, `markdown` and `code` carry neither anywhere, and position stops being part of the rule. **Consequences:** the heading, list-item and code-line anchor kinds are deleted with their checks and their `src/anchor.mjs` machinery, and an archived board carrying such a comment stops rendering it.

## 30. The tab mark stays amber; a numeral replaces the inverted tile — 2026-08-06
**Status:** accepted, supersedes 12
**Context:** entry 12's inversion made the tab stop looking like claude-board at exactly the moment it mattered, and showed a reviewer owing three answers the same pip as one owing one. **Decision:** pending keeps the page's own amber tile and draws a bold ink numeral onto it with canvas `fillText`, stepping 22/18/17px for one digit, two digits and the `9+` overflow. **Consequences:** ink mass rather than tile colour is the whole signal, and a canvas or font failure returns null, so the tab keeps the mark it already had. Why not an SVG data URI: DESIGN.md.

## 32. A rendered page reaches the board as a snapshotted stage, not a framed served file — 2026-08-07
**Status:** accepted
**Context:** `/visualize`, `/explain`, `/gamify` and the nightly digest all post a *link* to a 45-80 KB page instead of showing it, and up to a quarter of each skill's prose exists to justify that. **Decision:** the page is the existing `html` stage unboxed — bytes snapshotted at post time into the same opaque-origin `srcdoc` frame, laid out at viewport size. **Consequences:** an opaque origin resolves no relative subresource, so the artifact's CDN fallback must name the version the board CSP names, and 45-80 KB of markup lands in the board store per artifact. Why the daemon's own origin is never framed: DESIGN.md.

## 33. Fullpage is inferred from the board's shape, not declared by the caller — 2026-08-07
**Status:** accepted
**Context:** a `display: 'page'` field would make it explicit, at the cost of protocol surface every caller has to remember, where entry 26's equivalent inference has held. **Decision:** a board whose blocks are one `html` block and nothing else renders as a page board; anything else renders exactly as a board does today. **Consequences:** the rule is invisible at the call site, so a caller that posts a stats line beside its artifact silently loses fullpage, which is why the renderer skills drop the stats line.

## 35. An undelivered comment rides the thread's next packet — 2026-08-07
**Status:** accepted; narrowed by 45 and 46
**Context:** a page board asks nothing, so `ask` returns the instant it lands and the session is gone before the reviewer has read the artifact. **Decision:** a comment left on a board that returned no packet is held as undelivered and travels in the next packet the same thread returns, once. **Consequences:** collecting a comment costs a round that asks something, and a thread whose session ends before the reviewer comments strands it.

## 36. An upgrade widens a carried-forward root record back to the current defaults — 2026-08-07
**Status:** accepted
**Context:** `install.sh` carries an existing `ref_roots` record forward, so this machine's record predated `~/Documents/renders` and every artifact a page board would show failed to resolve. **Decision:** an upgrade adds any directory the current defaults name that the carried-forward record is missing, and prints the line naming what it widened. **Consequences:** a read allowlist grows without being asked, so the print is load-bearing and a narrow list now needs `CLAUDE_BOARD_REF_ROOTS` set explicitly.

## 38. `/file/` is deleted; the board is the only way to see a rendered page — 2026-08-07
**Status:** accepted, supersedes 10
**Context:** entry 10 existed because markdown cannot link to `file://`, and a page board embeds the artifact, so the route is now a second way to look at one thing. **Decision:** `handleServeFile`, `SERVE_CSP`, `SERVE_TYPES`, the `CLAUDE_BOARD_SERVE_ROOTS` allowlist and its install step and record file all go. **Consequences:** every already-archived board's link 404s, and an artifact is capped at one self-contained file, since an opaque origin resolves no relative URL.

## 40. The page board header condenses into a centred pill on reading — 2026-08-07
**Status:** accepted; corrected by 49; narrowed by 59; widened by 60
**Context:** the header has to be minimizable, and every treatment that puts a control on it spends a click and a piece of chrome on a state the reader's own scrolling already announces. **Decision:** scroll offset becomes a 0-to-1 progress across 140px (`--stage-p` on `<body>`), insetting a centred band behind a header that stays full-bleed and keeps the comment-mode toggle live. **Consequences:** the frame stays a constant viewport height, so condensing can never reflow a long document mid-read, and the stage agent gains a scroll message, shape-checked like every other on that channel. Why the ramp replaced a boolean flipped at 24px: DESIGN.md.

## 42. Rounds are the board's pages, flipped left and right — 2026-08-07
**Status:** accepted; narrowed by 61
**Context:** rounds stack vertically down one board, which a round that fills the viewport breaks outright. **Decision:** a thread keeps its single board and rounds become its pages — edge chevrons to flip, and a fixed `.round-pager-dock` of bare numerals dotting any round that still owes an answer. **Consequences:** the history rail is deleted, so the pager itself must keep a sent page read-only, and two rounds are never visible at once, so a question has to carry what it refers to. Why per-artifact boards and full round titles were dropped: DESIGN.md.

## 44. "A page board is never sent" is a browser rule, not a daemon rule — 2026-08-07
**Status:** accepted
**Context:** `handleSubmit` gates on the round number and its open status and never on what the round holds, so a request carrying the local write secret can submit an artifact round. **Decision:** the gate stays in the browser and the daemon keeps accepting any open round. **Consequences:** defence-in-one — it holds against every path a reviewer has, not against a caller that can post whatever board it likes anyway — and it keeps the one path that models an undelivered comment (`test/check-http.mjs`).

## 45. A page board may be awaited, and the caller declares it — 2026-08-07
**Status:** accepted; narrows 35, completed by 50
**Context:** entry 35 makes collecting a comment cost a round that asks something, and nothing in `blocks` can infer whether a caller wants to hear back. **Decision:** `ask` takes `wait`, default false; a page board posted with `wait: true` blocks as a question round does, carries Send and Discuss, and returns its comments in its own packet. **Consequences:** `blocks` still decides layout and `wait` only decides whether anyone is listening, and *awaited* becomes the single property behind sendability, the index badge and the notification. Why not wait on every page board: DESIGN.md.

## 46. Commenting exists only where someone is waiting — 2026-08-07
**Status:** accepted; narrows 35
**Context:** entry 45 leaves the non-awaited page board offering a gesture whose output nobody asked for. **Decision:** a page board that is not awaited is read-only — no comment toggle, no click-to-anchor, and the header pill says so — while an ordinary content round is untouched. **Consequences:** entry 35 narrows rather than being withdrawn, and "commentable" (CONTEXT.md) stops being a property of kind alone on this one surface.

## 47. The wait is 40 minutes, for every round, and the page shows what is left — 2026-08-07
**Status:** accepted
**Context:** two hours was set when nothing on the page said a clock was running, and since `ask` is the shim's only tool, nothing can read a board after its wait dies. **Decision:** the default wait drops to 40 minutes for every round shape, and the board shows the time left on the open round. **Consequences:** a review longer than 40 minutes has to be sent in parts, and the countdown is chrome the reviewer must be able to ignore.

## 48. The click-to-comment hint returns, in exactly one place — 2026-08-08
**Status:** accepted; recorded late; narrows 21
**Context:** entry 46 makes an awaited page board the one page where commenting is on from arrival, which removes the gesture's own teacher — everywhere else the mode toggle reveals it. **Decision:** one line of hint text, in that page's own comment panel and only while the panel is empty.

## 49. The page board's pill may hold a label alone — 2026-08-08
**Status:** accepted; recorded late; corrects 40
**Context:** entry 40's pill slot was built to carry a question count, entry 47 needed the page board to show the time left, and a page board has no questions while no other chrome survives the condense. **Decision:** the slot carries a label rather than a count — the countdown while the round is awaited, the bare word `read-only` the moment it is not. **Consequences:** the slot's contract widens from "a number and a noun" to "whatever names this page's state".

## 50. A wait that dies is recorded on the round — 2026-08-08
**Status:** accepted; completes 45
**Context:** entry 45's `awaited` flag was stamped at mint and never unstamped, so a lapsed round still counted toward the index badge, swallowed its own comments, and resumed on a re-post against a deadline already past. **Decision:** the deadline passing clears `awaited` at `readBoard`, the one choke point every reader of a stored board goes through; `awaitDeadline` and `status` are left alone, so a lapsed round stays distinguishable from one never awaited. **Consequences:** every surface keeps its bare `awaited` read and becomes correct for free, and a lapsed round is not re-waitable, which is the price of the single stored fact. Why not a clock in every reader: DESIGN.md.

## 55. A stranded round is announced, not opened onto — 2026-08-09
**Status:** accepted; narrows 4; widened by 58
**Context:** everything that raises a signal for an awaited round is code inside the board tab, so a reviewer who closes that tab mid-wait is told nothing for the rest of the wait; the shim's one cover, forcing a tab open when the board reports no client, runs at post time only, steals focus, and fires on the false zero an SSE reconnect produces. **Decision:** the daemon raises a native banner when a round becomes stranded, evaluated at post and again when the last watcher leaves, after a short grace; the shim's forced reopen is deleted and the first board of a thread still opens as it always has. **Consequences:** the reviewer chooses when to come back rather than having a tab appear mid-sentence, at the price of the daemon owning a per-board timer and a disconnect hook it did not before, and of a signal that is silent where notifications are.

## 56. The launcher may compose a notification body, behind a filter — 2026-08-09
**Status:** accepted; narrows 19
**Context:** entry 19's launcher lets argv select a row of a compiled-in table and name a sound, but never supply a word that is shown, deliberately, because it holds the reader's Documents grant and the plist that spawns it is user-writable; a banner that cannot name which project wants you is close to useless once more than one session runs. **Decision:** the launcher gains one format slot, filled only by an argument passing a strict name pattern in C, the same shape `is_safe_cue_name` already applies to a cue; an argument that fails the pattern selects the unnamed sentence instead of being rejected. **Consequences:** "no byte of argv reaches the screen" is given up and replaced by "no byte reaches the screen unfiltered", so the pattern is now load-bearing and belongs with the cue filter in review; a project name outside it degrades silently rather than failing loudly.

## 57. The banner opens the board it names — 2026-08-09
**Status:** accepted; narrows 9
**Context:** a banner that cannot be clicked can only say "go look", leaving the reviewer to find a board the banner is forbidden from linking; the posting binary must be the bundle's own executable, so no separate helper can serve the click. **Decision:** the notify mode registers an action category and a delegate and stays alive to serve one click, opening a plain board URL that must match a board URL pattern checked in C, and letting the browser's own long-lived session authorize it rather than carrying a credential in argv; the daemon owns it and kills it when the reviewer returns or the round is answered, with the round's deadline as the child's own backstop, because a lapsing wait fires no event a child could wait for. **Consequences:** a second process now exists per stranded board rather than per boundary and lives for minutes rather than seconds, so it must handle the signals the fire-and-exit mode never installed; a browser that has never opened a board lands on the existing refusal page; whether a click surfaces an existing tab on that board or opens a second one is the browser's own behaviour, since forcing a named tab forward would need the Apple Events automation entry 9 rules out; and the clone install keeps a banner it cannot click.

## 58. One notifier for a round, and it is the daemon's — 2026-08-09
**Status:** accepted; widens 55
**Context:** entry 55 gave the daemon a banner for a round nobody has a tab on, which left two implementations of one idea: the page notifying when its own tab is hidden, the daemon notifying when there is no tab, split on an accident of where the code can run rather than on anything a reviewer would recognise. The browser half also carries a permission grant that is per origin and per Chrome profile, so `localhost`, `127.0.0.1` and `board.localhost` are three separate answers and a denied prompt is unrecoverable in place. **Decision:** `notifyRound` and its permission request are deleted; the daemon raises every round notification, and the board tab reports whether it is Attended so the daemon can tell "you are looking at this" from "a tab exists". The favicon numeral stays, being a mark rather than a notification, and the title names the kind of thing that happened, `Board` beside the existing `Pomodoro`, with the body carrying the detail. **Consequences:** one notification identity, one on/off control and one System Settings row for the whole product, paid for with a new report from page to daemon, with the opened URL having to name the round so a click still lands where the deleted notification landed, and with the title becoming a per-row value rather than the constant each path compiles in separately today.

## 59. The board clears its own chrome band, the artifact does not — 2026-08-09
**Status:** accepted; narrows 40
**Context:** entry 40's floating header made every artifact responsible for ~96px of top padding, a number stated only as prose in `skills/claude-board/SKILL.md` against a header whose real height moves with the title's wrap and the viewport's width — so an artifact that padded nothing lost its own opening, silently, and nothing warned anyone. **Decision:** the parent reports its chrome band to the stage over the existing `stageAgentScript` channel and the stage tops its own `body` padding up to it, top and bottom, padding only and never a background. **Consequences:** the ~96px paragraph is deleted rather than corrected, an artifact that already pads keeps its own larger value, and the parent owes a fresh report on resize as well as at first paint.

## 60. The condense is every board's, not the page board's — 2026-08-09
**Status:** accepted; widens 40
**Context:** entry 40 gave the page board a condensing header and left the ordinary board a static sticky one, so two board types in the same product read as two designs. **Decision:** both condense into the same centred pill on scroll, keeping the controls in the order the expanded header already has (mark, comment toggle, theme, state label). **Consequences:** an ordinary board must reserve the header's flow box so condensing can never reflow its column, and the pill's contents become one spec serving both surfaces rather than a page-board special case.

## 61. The header stops naming the round — 2026-08-09
**Status:** accepted; narrows 42
**Context:** entry 42 put a fixed dock at the bottom of every board whose caption prints the round's full name at all times, which left the header's `round N of M` badge saying the same thing twice — and saying it on a button whose click already routed through the pager's own `goToRound`, three doors onto one mechanism. **Decision:** the badge goes, at rest and condensed alike; `badgeLabel` is deleted and `roundNumberLabel` becomes the single place a round is named. The state label beside it stays in both states, since the countdown it carries (entry 49) is the one thing on the header no other surface says. **Consequences:** `jumpToOpenRound` keeps its remaining callers (the notification, arrival from the index) and loses only the badge's, and "hide it when condensed" never becomes a rule because nothing is left to hide.

## 62. Third-party rendering code is vendored, not depended on — 2026-08-09
**Status:** accepted
**Context:** closing the markdown ceiling (`src/markdown.mjs:9-11`) and giving code blocks syntax highlighting both wanted a real parser, but the repo has no bundler, no `node_modules` and no package dependencies, and its daemon source is hashed into `install.sh`'s payload digest (entry 15). **Decision:** vendor `marked@18.0.9` (MIT, zero runtime deps, one self-contained 41.9 KB ESM file) and `prismjs@1.30.0` (MIT, self-contained 19.5 KB ESM core plus one grammar per language `langForPath` names) into `src/vendor/`, each at a pinned version with a recorded sha256 a check asserts offline. **Consequences:** the zero-dependency posture becomes zero-*installed*-dependency; the payload digest changes, so `./install.sh` is required rather than a bare kickstart; and `src/markdown.mjs` keeps ownership of `slugify` and of raw-HTML escaping through marked renderer overrides, because six modules and the archive id guard resolve `section` references through the existing slug scheme.

## 63. Code renders highlighted, six-hue, with the file's own line numbers — 2026-08-09
**Status:** accepted
**Context:** `renderCodeBlock` emitted plain escaped text, and `block.lang` was computed and then spent on kicker text. **Decision:** highlight server-side at post time, emitting classes and never inline colour so the theme toggle re-colours archived boards for free; adopt a six-hue palette (keyword, string, function, number, comment, base) as twelve new tokens across `DARK` and `LIGHT`; and number rows with the file's real line numbers from `source.lines` in a non-selectable gutter. **Consequences:** the "one accent plus semantic status colours" discipline no longer describes the code surface, and every new token owes `test/check-contrast.mjs` a 4.5:1 assertion against `--panel-2` in both themes.

## 64. A diff row suppresses syntax colour — 2026-08-09
**Status:** accepted; narrows 63
**Context:** entry 63's six hues measured against a conventional diff tint (α 0.12) fail WCAG on real rows — comments 3.96:1 on a dark addition, strings 4.12:1 on a light one — and sweeping the alpha put the ceiling where every token still passes at α≈0.045-0.06, a tint too faint to carry the add/remove signal on its own. **Decision:** inside a `diff` block, rows keep the conventional α 0.12 `--good`/`--critical` fill and syntax colour drops to `--code-ink`, with `--muted` italic comments. **Consequences:** a diff reads as a change rather than as code, the two colour systems never composite, and `.diff`/`.patch` join `langForPath`'s extension table so a referenced patch file resolves to this path with no new concept.
