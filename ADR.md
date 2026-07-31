# Architecture Decision Record

## 1. Theme selection is client-side only — 2026-07-30

**Context:** The board needed a light theme with a remembered manual override. The
natural implementation is a cookie the server reads, rendering the theme class into
the HTML — flash-free, and one preference regardless of which loopback host or port
the reader arrives on. But the served page and the standalone `pages/*.html` archive
are asserted byte-identical, and the page's bytes are documented as a pure function
of the board JSON. A server that varies its output by request state breaks both.

**Decision:** The theme is chosen entirely in the browser: a media query supplies the
default, and an override lives in `localStorage`, applied by an inline script that
runs before first paint. The server learns nothing about the reader's preference.

**Consequences:** The byte-identity invariant survives untouched, and no new
server-side state or endpoint exists. In exchange the preference is scoped to
scheme+host+port, so it does not follow the reader across `127.0.0.1`, `localhost`
and `*.localhost`, and changing `CLAUDE_BOARD_PORT` orphans it. Standalone archives
follow the OS and forget any override when closed, but not because `file://` blocks
storage — it doesn't, in Chrome or Firefox. `src/theme.mjs` explicitly gates every
storage access on `location.protocol !== 'file:'`, a product decision: every `file://`
document on the machine shares one storage partition, so an ungated archive would
read and write a preference belonging to every other archive ever opened from disk,
not only its own. Host canonicalization would collapse the origin split but was
ruled out as too large a change to security-reviewed Host handling for a cosmetic
preference.

_Amended 2026-07-31 after the audit._ This entry originally read: "Standalone
archives open at a `file://` opaque origin and therefore cannot read or write it at
all." Measured wrong: `file://` pages have working `localStorage`. The gate above,
not the platform, is what actually stops the archive — treating it as redundant and
removing it would make an archive persist a preference again, breaking acceptance
criterion 9.

## 2. Comments are deletable only before Send — 2026-07-30

**Context:** A comment queued in comment mode could not be removed at all, and clicking
the same element twice silently queued a second comment on the same anchor. Fixing the
gesture raised how far "delete" reaches. Server-side, `board.comments` is append-only and
a comment's `n` is `board.comments.length + 1` (`src/board.mjs`), which is simultaneously
its pin number, its identifier in the packet handed to the agent, and its position in the
archive.

**Decision:** Deletion and editing apply only to comments still queued in the page's
`pendingComments` array. A second click on an element with an unsent comment reopens it
prefilled; a second click on an element with a *sent* comment does nothing and is
de-affordanced in comment mode. Nothing removes or renumbers a comment after Send.

**Consequences:** No delete endpoint, no protocol change, no renumbering of anything the
agent has already read, and the archive stays a faithful record of the exchange — which
is what criteria 4 and 14 rest on. In exchange, a typo noticed one second after Send is
permanent, and the reviewer's only recourse is a second comment correcting the first.
Rejected: click-to-toggle-delete, destructive on a single click with no confirmation;
rejected: deleting within a still-open round, which produces no packet yet but does
require an endpoint and a decision about gaps in the `n` sequence.

## 3. References resolve inside a configured allowlist, not only `cwd` — 2026-07-30

**Context:** `src/resolve.mjs` confined every reference to the board's own `cwd`. That is
half of a real boundary — the other half being that a caller choosing `cwd: '/'` reaches
everything anyway — but it also means a session can never render the skill, command or
agent file it is discussing. Grilling this repo hit the refusal twice in one session,
since the subject matter *is* `~/.claude` content.

**Decision:** References resolve if they sit under `cwd` **or** under one of a configured
set of roots, supplied as `CLAUDE_BOARD_REF_ROOTS` (colon-separated absolute paths),
defaulting to ~~`~/.claude`~~ **`~/.claude/skills`, `~/.claude/commands` and
`~/.claude/agents`** (amended 2026-07-31; see below). Each root is validated exactly as
`resolveBoardCwd` already validates `cwd`: realpath'd, must be an existing directory,
refused if it is `/` or `$HOME` or above.

**Amendment, 2026-07-31 — the default narrows to three directories.** The justification
in this entry's own Context is "render the skill, command or agent file it is
discussing", and that is exactly `~/.claude/skills`, `~/.claude/commands` and
`~/.claude/agents`. The rest of that tree is `settings.json`, `.credentials.json`, shell
snapshots, project transcripts and every plugin's private state, none of which the case
above ever asked for — the old default granted them by writing down a parent directory
rather than the three the argument named. Two mechanical consequences follow, both
recorded here because they are the part a reader would otherwise have to reconstruct:

- **An absent `CLAUDE_BOARD_REF_ROOTS` now means an empty allowlist**, not the default.
  Every install predating this entry has a plist with no such key, and the daemon
  restarts itself whenever `src/` changes, so a default living in code would have gone
  live on those machines during an ordinary `git pull` — the boundary widening itself
  with nothing printed and nobody asked. The default lives in `install.sh` instead, which
  makes running the installer the consent event.
- **`install.sh` carries an installed plist's value forward** when the variable is unset,
  rather than rewriting it from the default. Otherwise an operator who narrowed the
  boundary deliberately had that decision reverted by their next upgrade.

`CLAUDE_BOARD_REF_ROOTS=$HOME/.claude` still does exactly what it says, for anyone who
wants the whole tree.

**Consequences:** Widens what a confused or hostile agent can pull into a board, and
boards embed the content they resolve — so this enlarges the corpus reachable by anyone
holding the session cookie. `SECURITY.md`'s statement of the reference boundary has to be
rewritten rather than amended. The daemon runs under launchd, so the variable must reach
it through the plist and therefore through `install.sh`; a misconfigured root silently
widens the gate, which is the cost of making it configurable at all. Rejected: hardcoding
`~/.claude` (smallest widening, but every other tool's config is then unreachable);
rejected: dropping confinement entirely, which is more honest about the weak boundary but
rewrites the security posture for a convenience fix.

One consequence this entry did not anticipate, found by audit on 2026-07-31 and worth
recording where the decision is: making the allowlist *always populated and always
agent-writable* changed the value of defects the `cwd`-only boundary also had. The gap
between checking a path and re-opening it was raceable before, but only by something that
could already write inside the project; with roots that are always present it became a
general escape, and was closed by resolving each reference to a descriptor once and
reading from that. A hard link into a root is the same shape and is not closed — see
`SECURITY.md`, "Not defended, by design".

## 4. PROPOSED — Every command falls back off the board, `/grill` included — 2026-07-31

**Context:** `SPEC_LAUNCH.md` and `commands/grill.md` both state the opposite, deliberately
and at length: there is no automatic fallback to the terminal for a board-shaped round,
because "a feature that quietly downgrades is a feature that stays broken for a week." The
shim enforces it by refusing a non-interactive session before posting anything. Migrating
`/audit`, `/example` and the renderers onto the board made that rule load-bearing for
commands that do have a terminal path — and the reviewer wants these runnable headless, on a
VPS, where the shim refuses by design.

**Decision:** Every command carries a non-board path and takes it on three triggers,
announcing that it did: the board is unreachable, the session is headless, or **the daemon
cannot open a tab**. The third was added in round 7 and is the VPS case the reviewer actually
meant — SSH gives `CLAUDE_CODE_ENTRYPOINT=cli`, so the interactive check passes and the daemon
is reachable, but `openBoardTab` returns silently off darwin without `CLAUDE_BOARD_OPEN_CMD`
(`bin/mcp.mjs:328`); the board posts where nobody can see it and `ask` blocks for the full two
hours. The shim refuses that case up front so it surfaces as an `isError` like the other two.
`CLAUDE_BOARD_HEADLESS=1` — which already exists (`bin/mcp.mjs:94`) — is documented as the
manual opt-out for a machine that *could* open a tab. A fallback is **degraded, not
equivalent**: it promises a path exists, never the same experience. `/grill` falls back to
`AskUserQuestion` and loses multi-select, ranking, attached context and comment anchoring.
`/example` writes its HTML and says the visual choice was unavailable. `/audit` writes the
findings file it writes today.

**Consequences:** The rule the launch spec picked to protect is gone, and the failure it
predicted is now possible: a broken board can go unnoticed for as long as the degraded path
keeps working, which is exactly how the EPERM defect survived seven rounds. What replaces it
is announcement rather than refusal, which is weaker and depends on a human reading the line.
`commands/grill.md`'s "Fail loudly, don't fall back" section and the
`no automatic terminal fallback is described` case in `test/check-grill.mjs` both have to be
rewritten, so this reaches published docs and a check, not just a prompt. It stops there,
though: `bin/mcp.mjs` keeps returning `isError` on an unreachable daemon and that assertion
stays, so only the command's *response* to the error changes. "Loud" survives;
"unrecoverable" is what was actually traded away. Accepted because the alternative is that a headless
runner cannot use any migrated command at all, and because the board is additive for every
command but `/grill` — for `/grill` alone, the fallback genuinely loses the artifact.
Rejected: migrated commands fall back and `/grill` does not (two rules, and the VPS case
still fails for the one command most likely to be run there); rejected: nothing falls back,
which leaves "the daemon is merely down on your own machine" unanswered.

**Status: proposed, not accepted.** This entry was written as accepted, which the repository
did not support: neither rewrite it names as required — `commands/grill.md`'s "Fail loudly,
don't fall back" section and `test/check-grill.mjs`'s `no automatic terminal fallback is
described` case — has landed, so the shipped behaviour is still the *opposite* rule. Recorded
as proposed so the file matches the code (audit 2026-07-31 Sp5). Accepting it means doing
those two rewrites in the same change.

## 5. PROPOSED — This repo ships the protocol, not its callers — 2026-07-31

**Context:** `install.sh` has always installed three things: the LaunchAgent, the local secret,
and `commands/grill.md` copied to `~/.claude/commands/`. That third step made sense while
`/grill` was the board's only caller and this repo had written it. `SPEC_MIGRATION.md` then
grew four skills and a second command as callers, none of which this repo wrote, and asked
whether they should move in. Round 9 said no for the skills. Round 10 said no for `/wayfind`,
then went further than the question asked: *"Move grill out of repo, let's keep all the skills
and commands out of repo I know this is a big change."*

**Decision:** `claude-board` ships the daemon, the shim, the protocol and the shared prose
checker. It ships **no callers**. `commands/grill.md` is deleted from the repo and lives only
at `~/.claude/commands/grill.md`; `install.sh` drops its third install step and no longer
requires that file to exist. Skills and commands are personal, versioned in `~/.claude`'s own
git repo, and evolve on their own schedule.

**Consequences:** The repo gets a clean boundary — one artifact, one job — and callers stop
being coupled to this project's release cycle. What it costs is the thing that made the
boundary safe: `test/check-grill.mjs` is the only check in this repo that binds prose to
mechanism, and its subject leaves. After the move, **nothing in this repo's suite proves any
prose matches the shim**; the repo ships a library and trusts callers to run it. That inverts
the dependency too — personal skills now import a path inside this repo and stop working
standalone if it moves. `SPEC_MIGRATION.md` criterion 12 owns that seam and round 10 left it
`deferred`, so the shape is chosen but not settled.
Rejected: callers move IN (checkable in CI, but this repo starts shipping ~110KB of templates
it did not author, and your skills couple to its releases); rejected: the status quo, one
caller in and five out, which is a rule with no principle behind it.

**Status: proposed, not accepted.** Nothing has moved yet: `commands/grill.md` is still in the
repo and `install.sh` still installs it. Accepting means doing the move, the `install.sh`
edit, and answering criterion 12 in the same change — otherwise the repo loses its only prose
binding and gains nothing in exchange.
