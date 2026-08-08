# Architecture Decision Record

## Index

| # | Decision | Date | Status |
|---|---|---|---|
| 1 | Theme selection is client-side only | 2026-07-30 | accepted |
| 2 | Comments are deletable only before Send | 2026-07-30 | accepted (see *Smaller decisions*) |
| 3 | References resolve inside a configured allowlist, not only `cwd` | 2026-07-30 | accepted |
| 4 | Every command falls back off the board, `/grill` included | 2026-07-31 | accepted |
| 5 | This repo ships the protocol, not its callers | 2026-07-31 | accepted; weakened by 11 |
| 6 | Commenting is confined to content blocks | 2026-08-01 | accepted; **narrowed by 28** |
| 7 | An `html` block may name a file, but only a whole one | 2026-08-04 | accepted |
| 8 | The daemon owns the pomodoro clock | 2026-08-04 | accepted |
| 9 | No menu bar item — the bundle's signature is load-bearing | 2026-08-04 | accepted |
| 10 | The daemon serves a rendered file, it does not render one | 2026-08-04 | accepted |
| 11 | The repo ships one caller-facing file: the manual | 2026-08-04 | accepted; weakens 5 |
| 12 | The mark is amber | 2026-08-04 | accepted; **inversion half superseded by 30** |
| 13 | The daemon's environment is baked into the launcher, not the plist | 2026-08-04 | accepted |
| 14 | The launcher is compiled from a staged copy; the stamp covers the binary | 2026-08-04 | accepted |
| 15 | The daemon's own code is staged into the signed bundle | 2026-08-04 | accepted |
| 16 | The index search box filters sessions; it does not search inside them | 2026-08-04 | accepted (see *Smaller decisions*) |
| 17 | The pomodoro switch may start a timer, so the cookie may call `ensure` | 2026-08-04 | accepted (see *Smaller decisions*) |
| 18 | The boundary cue is played, not attached to the notification | 2026-08-05 | **superseded by 20** |
| 19 | The pomodoro notification is posted by the bundle, not by osascript | 2026-08-05 | accepted |
| 20 | The cue is a bare name, so macOS owns the cue | 2026-08-05 | accepted; supersedes 18 |
| 21 | The per-stage comment hint is deleted | 2026-08-05 | accepted (see *Smaller decisions*) |
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

## Smaller decisions

Settled without a rejected alternative anyone would plausibly have taken, so recorded
in a line rather than argued at length.

| # | Decision | Date | Status |
|---|---|---|---|
| 2 | Delete and edit reach only comments still in `pendingComments`; `board.comments` is append-only. | 2026-07-30 | accepted |
| 16 | The index search box filters the thread list; `GET /api/search` stays the only full-text surface. | 2026-08-04 | accepted |
| 17 | `ensure` joins `POMODORO_COOKIE_ACTIONS`, which stays a closed named list rather than a prefix match. | 2026-08-04 | accepted |
| 21 | `stageHint` is deleted on both stage kinds; the comment-mode toggle carries discoverability alone. | 2026-08-05 | accepted |
| 24 | Forward applies the natural advance rule at click time and fires no notification and no cue. | 2026-08-05 | accepted |
| 25 | The index badge counts open rounds still asking something (`N rounds left`), hidden at zero. | 2026-08-06 | accepted |
| 27 | A grey pill above the send bar names the unanswered count and jumps to the first; it does not touch the guard. | 2026-08-06 | accepted |
| 29 | Arriving at Send with nothing outstanding submits; otherwise the click guard arms. `armSend` is deleted, leaving one armed state. | 2026-08-06 | accepted |
| 31 | The rest tile mints `--mark-rest-tile` instead of reading `--scrollbar-hover`, so a scrollbar restyle cannot move the tab mark. | 2026-08-06 | accepted |

## 1. Theme selection is client-side only — 2026-07-30
**Status:** accepted
**Context:** a server-read theme cookie would break the asserted byte-identity of the served page and the `pages/*.html` archive. **Decision:** the theme is chosen entirely in the browser — media query default, `localStorage` override, applied by an inline script before first paint. **Consequences:** the preference is scoped to scheme+host+port and orphaned by a port change, and `src/theme.mjs` gates every storage access on `location.protocol !== 'file:'` so an archive never reads a preference belonging to every other `file://` document on the machine.

## 3. References resolve inside a configured allowlist, not only `cwd` — 2026-07-30
**Status:** accepted
**Context:** confining every reference to the board's `cwd` meant a session could never render the skill, command or agent file it was discussing. **Decision:** references resolve under `cwd` or under `CLAUDE_BOARD_REF_ROOTS`, defaulted in `install.sh` rather than in code so that running the installer is the consent event and a `git pull` never widens the boundary silently. **Consequences:** enlarges the corpus reachable by anyone holding the session cookie; an always-populated allowlist also turned a check-then-open race into a general escape, closed by resolving each reference to a descriptor once, while a hard link into a root stays undefended by design (SECURITY.md).

## 4. Every command falls back off the board, `/grill` included — 2026-07-31
**Status:** accepted
**Context:** the shim refused a non-interactive session by design, which made every migrated command unusable headless on a VPS. **Decision:** every command carries a non-board path and announces taking it, on three triggers — the daemon is unreachable, the session is headless, or the daemon cannot open a tab. **Consequences:** a broken board can now go unnoticed behind a degraded path that keeps working, and `/grill` alone genuinely loses its artifact — multi-select, ranking, attached context and comment anchoring.

## 5. This repo ships the protocol, not its callers — 2026-07-31
**Status:** accepted
**Context:** `install.sh` installed `commands/grill.md` back when `/grill` was the board's only caller, and then five more callers appeared that this repo never wrote. **Decision:** the repo ships the daemon, the shim, the protocol and the prose checker, and no callers; `commands/grill.md` is deleted here and lives only at `~/.claude/commands/grill.md`. **Consequences:** callers stop being coupled to this repo's release cycle but now import a path inside it; entry 11 later weakens the boundary to ship one file, the manual.

## 6. Commenting is confined to content blocks — 2026-08-01
**Status:** accepted; narrowed by 28, which drops `markdown` and `code`
**Context:** `question` and `compare` render no content of their own, so a comment anchored to either names nothing the agent can act on. **Decision:** the split is wrapper versus content — `markdown`, `mermaid`, `html` and `code` keep the button and the click-to-anchor gesture, `question` and `compare` lose both, and nested blocks keep theirs. **Consequences:** comments already stored against those kinds in archived boards are not a supported case.

## 7. An `html` block may name a file, but only a whole one — 2026-08-04
**Status:** accepted
**Context:** an 80 KB rendered page could reach a board only as ~25-30K generated tokens, a price an agent silently declined to pay, posting a stub and misreporting a size limit as the cause. **Decision:** `html` accepts `source: { path }` through the same reader, confinement, cap and error behaviour as every other kind, refusing `lines` and `section` because markup does not survive slicing. **Consequences:** `html` becomes the only path-only ref, an exception readers trip over, and a referenced file executes in the stage on exactly the footing an inline mock already did — recorded in SECURITY.md rather than defended against.

## 8. The daemon owns the pomodoro clock, unlike every other preference — 2026-08-04
**Status:** accepted
**Context:** entry 1 put preferences in the browser and that held for every setting since, but a timer you lose by closing a tab is not a timer. **Decision:** the daemon persists the interval's absolute wall deadline, the cycle counter and the durations beside the board store; the browser only renders a countdown from that deadline. **Consequences:** the daemon becomes stateful about something that is not a board, and entry 1's principle now needs its boundary stated — a theme is a per-reader preference, a pomodoro is a single fact about the human.

## 9. No menu bar item — the app bundle's signature is load-bearing — 2026-08-04
**Status:** accepted
**Context:** a menu bar countdown looks nearly free in an always-on tool that already ships a macOS app bundle. **Decision:** no `NSStatusItem` and no AppKit in `bin/launcher.c`; the pomodoro surfaces are a native notification at each boundary and a widget on the index page. **Consequences:** the always-visible glance is what is given up, in exchange for never rebuilding the ad-hoc signature gratuitously and costing the reader the TCC Documents grant this repo's own location depends on; a second dedicated bundle, not AppKit in the launcher, is the shape to revisit.

## 10. The daemon serves a rendered file, it does not render one — 2026-08-04
**Status:** accepted
**Context:** a posted absolute path is not clickable — markdown allows only `http(s)` and `mailto`, and no browser navigates from `http://127.0.0.1` to `file://`. **Decision:** `GET /file/<path>` streams bytes from `CLAUDE_BOARD_SERVE_ROOTS` — its own allowlist, not the reference roots — with no wrapping, slicing, capping or directory listing. **Consequences:** the served response sets `connect-src 'none'` and `form-action 'none'` because it is same-origin with `/api/board` under a `SameSite=Strict` cookie, and every refusal collapses to a bare 404, so a dropped root looks exactly like a typo.

## 11. The repo ships one caller-facing file: the manual — 2026-08-04
**Status:** accepted
**Context:** six callers outside this repo each restated how to call `ask` — 148 lines, three of them word-for-word identical, and already drifted on widgets, recovery command and `html` refs. **Decision:** `skills/claude-board/SKILL.md` ships from here and `install.sh` copies it unconditionally; a manual is the protocol in the form an agent reads, not a caller. **Consequences:** entry 5's boundary weakens from "no files" to "one file, and we authored it", needing defence every time something else asks to ship, and in exchange `test/check-skill-prose.mjs` binds prose to mechanism in the same repo as the shim, checking for absence as well as drift.

## 12. The mark is amber, so the brand shares a hue with "waiting on you" — 2026-08-04
**Status:** accepted; its inversion half superseded by 30, which holds the tile constant and lets a numeral carry the count
**Context:** a favicon gets no CSS and no useful `prefers-color-scheme`, and `--accent`'s two theme values sit too far apart for one tile to serve both tab strips. **Decision:** the mark takes `DARK['--warning']`, the one hue this palette carries at nearly the same value in either theme, and the pending mark inverts that same tile rather than adding a pip to it. **Consequences:** the brand permanently shares a hue with a state colour, so a `--warning` retune moves it silently — accepted for the token discipline — and the explicit `DARK` naming must survive, since light's `#805300` would render the tile as mud.

## 13. The environment the daemon runs in is baked into the launcher, not read from the plist — 2026-08-04
**Status:** accepted
**Context:** the plist is mode 644 and user-writable, so a `NODE_OPTIONS=--require` key ran arbitrary code inside the TCC-granted process with the bundle's signature untouched and nothing to distinguish it from a tuning knob. **Decision:** `bin/launcher.c` `execve`s an environment it constructs itself — the five variables that decide what the daemon may read, serve and write are compiled in via `launcher_paths.h`, six named variables pass through, and everything else is never placed there at all. **Consequences:** retargeting a root now costs a rebuild, a re-sign and a TCC re-approval, and `install.sh` records the effective roots in the 0700 directory beside the secret rather than reading them back out of a plist it no longer writes them to.

## 14. The launcher is compiled from a staged copy, and the rebuild stamp covers the produced binary — 2026-08-04
**Status:** accepted
**Context:** a quoted `#include` searches its own directory first, so a `launcher_paths.h` dropped into `bin/` shadowed the generated header and was compiled and signed into the granted bundle, invisibly in `git status`. **Decision:** `install.sh` stages `bin/launcher.c` beside the generated header and compiles with `-iquote`, warning non-fatally about a header left in the clone, and the stamp gains the sha256 of the installed executable computed after the atomic `mv`. **Consequences:** identical inputs still report "already current" so the TCC grant survives a routine reinstall, and the executable hash is redundant with `codesign --verify` today, kept for the day a bypass or format quirk makes that check less than airtight.

## 15. The daemon's own code is staged into the signed bundle, not left running from the clone — 2026-08-04
**Status:** accepted
**Context:** entries 13 and 14 made the launcher trustworthy, but it forked node against `bin/daemon.mjs` and `src/` sitting unsigned and user-writable in a plain git clone, so an edit took effect on the next request under the granted identity. **Decision:** `install.sh` stages both into `Contents/Resources` before `codesign`, `CLAUDE_BOARD_DAEMON` names the installed copy, and a payload digest over a sorted file list — deterministic, so a clean checkout never forces a gratuitous rebuild — joins the stamp. **Consequences:** the clone becomes a build input, so a bare `kickstart` no longer picks up a source edit, and a sixth compiled-in override `CLAUDE_BOARD_REPO_ROOT` keeps the refusal page naming the clone's `bin/authorize.mjs`.

## 18. The boundary cue is played, not attached to the notification — 2026-08-05
**Status:** superseded by 20
**Context:** `UNNotificationSound soundNamed:` resolves against the bundle's own Resources, so a per-phase cue would have worked on the clone install's `osascript` path and collapsed to one generic sound on the bundled one. **Decision:** the daemon plays the cue itself with `afplay /System/Library/Sounds/<Name>.aiff` and posts every notification silent on both paths. **Consequences:** three genuinely distinct cues on every install, but macOS stops owning the cue — a Focus does not silence it and it has no row in System Settings, which is the cost entry 20 refused.

## 19. The pomodoro notification is posted by the bundle, not by osascript — 2026-08-05
**Status:** accepted
**Context:** a notification's name, icon and System Settings row all come from the posting process's bundle and cannot be overridden; node has no bundle, so `osascript` gave the pomodoro Script Editor's identity, and entry 15 had since removed entry 9's reason for tolerating that. **Decision:** `bin/notify.m` compiles into the launcher binary, `bin/launcher.c` gains a `--notify <phase>` mode, `src/notify.mjs` spawns it when running from inside the bundle, and `osascript` stays only for the bundle-less install. **Consequences:** the reader can set Alerts on claude-board's own row so boundaries stay on screen, paid for with a launcher that reads argv (one index into a closed table of three sentences, in a mode launchd never invokes), one more permission prompt at install time, and a guarded `lsregister -f` call before asking.

## 20. The cue is a bare name, not a staged file, so macOS owns the cue — 2026-08-05
**Status:** accepted, supersedes 18
**Context:** a cue the daemon plays is not a notification, so no Focus, per-app toggle or notification switch can silence it — and entry 18 mispriced the alternative, since entry 15 already re-signs on any `src/` change, making the marginal cost of shipping sound files zero re-approvals. **Decision:** the cue is a bare name resolved where it already lives — `UNNotificationSound soundNamed:` on the bundled path, AppleScript's `sound name` on the clone path, the same names either way; nothing is copied anywhere and `install.sh` is untouched. (Staging `/System/Library/Sounds/*.aiff` into `Contents/Resources` was this entry's first plan and does not work at all; QUIRKS.md has the measurement.) **Consequences:** every macOS notification control reaches the cue, at no bundle growth, no install step and no re-approval; the picker (`src/cues.mjs`) enumerates the very directory macOS resolves against, so there are not two lists to keep in sync; the picker's own preview stays deliberately outside that filtering, since auditioning a cue must not raise a banner. Rejected: symlinking into `~/Library/Sounds`, refused because that namespace is shared — the entries would surface in every other app's picker and `uninstall.sh` would grow a cleanup step distinguishing its own symlinks from a reader's.

## 22. The stage lens may record a pick, so a selection control shares a screen with untrusted content — 2026-08-05
**Status:** accepted
**Context:** a variant option's stage is inert so that only a real reviewer click can record a pick, and the lens added so a mock can be judged at readable size makes that same stage live. **Decision:** the lens carries a control that picks the option it was opened from and closes in the same act, naming that option in page chrome outside the framed stage, while the card's stage stays inert. **Consequences:** a selection control now shares a screen with agent-authored content, so the residual risk is a mock drawing convincing fake chrome rather than the stage pressing anything (`test/check-stage-isolation.mjs`).

## 23. The cue picker reads `~/Library/Sounds` as well, so the reader can add their own cues — 2026-08-05
**Status:** accepted, extends 20
**Context:** the stock 14 are the only cues on offer, and a reader who wants a gong has nowhere to put one. Entry 20 rejected *writing* into `~/Library/Sounds`, on the grounds that the namespace is shared and `uninstall.sh` would have to tell its own files from the reader's; reading it incurs neither cost. **Decision:** `SOUNDS_DIRS` replaces the single `SOUNDS_DIR`, holding `/System/Library/Sounds` and `~/Library/Sounds`, with `cueNames()` unioning them and `cuePath()` walking them in the order QUIRKS.md measures macOS to prefer, so the preview plays whichever file the notification will. The daemon still writes nothing, and `install.sh` and `uninstall.sh` stay untouched. **Consequences:** adding a cue is dropping an `.aiff` into a directory macOS already searches, and the picker keeps enumerating exactly what macOS can resolve, so there are still not two lists to keep in sync. The memo behind `cueNames()` grows a 5s TTL, since the set can now change under a running daemon and a cue needing a restart to appear is a cue nobody finds. A name present in both directories resolves to the *system* copy (QUIRKS.md), so a reader who names a file after a stock sound has shadowed nothing and will never hear it.

## 26. A question's context is prose under the prompt, and it stops being commentable — 2026-08-06
**Status:** accepted; its comment half superseded by 28, which narrows by kind rather than by position
**Context:** `.question-block` split into two columns whenever a question carried any context, so a `choose-between-rendered-variants` question — whose options *are* the thing being looked at — rendered its stages at roughly half the column while a code excerpt took the rest. Reported from real use, on a round the reviewer could not answer. **Decision:** a question carrying a rendered stage lays out full width, and context stacks under the prompt as plain prose with no card, no kicker and no comment control. Entry 6's rule is unchanged — commenting is confined to content blocks — but a context block is no longer rendered as one. **Consequences:** context cannot be pointed at in a comment; feedback on it goes in the question's own note. In exchange the manual can stop treating a code excerpt as the default attachment, which is what made the column worth having.

## 28. Only the rendered kinds can be commented on — 2026-08-06
**Status:** accepted, supersedes the comment half of 26 and narrows 6
**Context:** entry 6 left `markdown`, `code`, `mermaid` and `html` all commentable, on the reasoning that a question's context is where the material worth pointing at actually lives. Entry 26 then removed the affordance from context by position. The reviewer, who is the only person who uses it, comments on rendered output and never on prose or code — so the rule was drawn on the wrong axis twice. **Decision:** the comment button and the click-to-anchor gesture belong to `html` and `mermaid`, wherever they appear, including inside a question's `context` and a `compare` side. `markdown` and `code` carry neither, anywhere. Position stops being part of the rule. **Consequences:** the markdown-heading, top-level-list-item and code-line anchor kinds are deleted along with their checks, and `src/anchor.mjs` loses the machinery behind them; an archived board carrying a `markdown` or `code` comment stops rendering it, the same case entry 6 already declared unsupported. the manual and `PROTOCOL.md` both stated the wider rule and have been narrowed to match.

## 30. The tab mark stays amber; a numeral replaces the inverted tile — 2026-08-06
**Status:** accepted, supersedes 12
**Context:** entry 12 bought a value flip by spending the one thing a favicon can't spend and still read as this product: pending swapped the page's amber tile for a dark one carrying an amber pip, so the tab stopped looking like claude-board at exactly the moment it mattered, and a reviewer owing three answers saw the same undifferentiated pip as one owing one. **Decision:** pending keeps the page's own amber tile — same fill, same `rx 9` corner — and draws a bold ink numeral onto it with canvas `fillText`, not another SVG data URI: SVG favicons resolve fonts inconsistently, and a dropped family there would silently render a blank amber tile that reads as idle, the worst failure this mark could have. Sizes step 22px/18px/17px for one digit, two digits and the `9+` overflow (now capped at 99, not 9), optical steps rather than a linear scale so the digit survives the 16px downsample. **Consequences:** the tile is one constant object in every state, so ink mass — not tile colour — is the whole signal; a canvas or font failure degrades to whatever mark the tab already had (never a blank amber square) by returning null and leaving `setFaviconBadge` with nothing to swap in. The inverted tile and its pip are deleted outright, not left unused — `test/check-pure.mjs`'s three prior checks on the countless mark are rewritten against this contract rather than dropped.

