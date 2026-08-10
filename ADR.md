# Architecture Decision Record

Entries live one per file in [`.agents/adr/`](.agents/adr/), numbered `NNNN-slug.md`. This file is
the index; read it, then open only the entries you need.

An entry is here because reversing it costs something real, a future reader would find it
inexplicable, and a genuine alternative was on the table. All three, or it is not a decision
record: a small decision is not recorded more briefly, it is not recorded. A superseded entry is
**deleted** rather than kept with a status — git holds the trail. Numbers are never reused, so
gaps are normal and an `ADR.md entry N` reference can never come to mean a decision other than
the one it was written against. A reference to a deleted entry is repointed at the entry that
superseded it, or dropped when nothing did.

Rejected alternatives and the reasoning behind an entry live in `DESIGN.md`, which the entries
link where it is worth reading.

| # | Decision | Date | Relations |
|---|---|---|---|
| 1 | [Theme selection is client-side only](.agents/adr/0001-theme-selection-is-client-side-only.md) | 2026-07-30 | accepted |
| 3 | [References resolve inside a configured allowlist, not only `cwd`](.agents/adr/0003-references-resolve-inside-a-configured-allowlist-not-only.md) | 2026-07-30 | accepted |
| 4 | [Every command falls back off the board, `/grill` included](.agents/adr/0004-every-command-falls-back-off-the-board-grill.md) | 2026-07-31 | narrowed by 55 |
| 5 | [This repo ships the protocol, not its callers](.agents/adr/0005-this-repo-ships-the-protocol-not-its-callers.md) | 2026-07-31 | accepted |
| 7 | [An `html` block may name a file, but only a whole one](.agents/adr/0007-html-block-may-name-a-file-but-only.md) | 2026-08-04 | accepted |
| 8 | [The daemon owns the pomodoro clock](.agents/adr/0008-daemon-owns-the-pomodoro-clock.md) | 2026-08-04 | narrowed by 67 |
| 11 | [The repo ships one caller-facing file: the manual](.agents/adr/0011-repo-ships-one-caller-facing-file-the-manual.md) | 2026-08-04 | accepted |
| 13 | [The daemon's environment is baked into the launcher, not the plist](.agents/adr/0013-daemon-s-environment-is-baked-into-the-launcher.md) | 2026-08-04 | accepted |
| 14 | [The launcher is compiled from a staged copy; the stamp covers the binary](.agents/adr/0014-launcher-is-compiled-from-a-staged-copy-the.md) | 2026-08-04 | accepted |
| 15 | [The daemon's own code is staged into the signed bundle](.agents/adr/0015-daemon-s-own-code-is-staged-into-the.md) | 2026-08-04 | accepted |
| 19 | [The pomodoro notification is posted by the bundle, not by osascript](.agents/adr/0019-pomodoro-notification-is-posted-by-the-bundle-not.md) | 2026-08-05 | narrowed by 56 |
| 20 | [The cue is a bare name, so macOS owns the cue](.agents/adr/0020-cue-is-a-bare-name-so-macos-owns.md) | 2026-08-05 | accepted |
| 22 | [The stage lens may record a pick](.agents/adr/0022-stage-lens-may-record-a-pick.md) | 2026-08-05 | accepted |
| 26 | [A question's context is prose under the prompt](.agents/adr/0026-question-s-context-is-prose-under-the-prompt.md) | 2026-08-06 | comment half superseded by 28 |
| 28 | [Only the rendered kinds can be commented on](.agents/adr/0028-only-the-rendered-kinds-can-be-commented-on.md) | 2026-08-06 | supersedes the comment half of 26 |
| 30 | [The tab mark stays amber; a numeral replaces the inverted tile](.agents/adr/0030-tab-mark-stays-amber-a-numeral-replaces-the.md) | 2026-08-06 | narrowed by 66 |
| 32 | [A rendered page reaches the board as a snapshotted stage, not a framed served file](.agents/adr/0032-rendered-page-reaches-the-board-as-a-snapshotted.md) | 2026-08-07 | accepted |
| 33 | [Fullpage is inferred from the board's shape, not declared by the caller](.agents/adr/0033-fullpage-is-inferred-from-the-board-s-shape.md) | 2026-08-07 | accepted |
| 35 | [An undelivered comment rides the thread's next packet](.agents/adr/0035-undelivered-comment-rides-the-thread-s-next-packet.md) | 2026-08-07 | narrowed by 45 and 46 |
| 36 | [An upgrade widens a carried-forward root record back to the current defaults](.agents/adr/0036-upgrade-widens-a-carried-forward-root-record-back.md) | 2026-08-07 | accepted |
| 38 | [`/file/` is deleted; the board is the only way to see a rendered page](.agents/adr/0038-file-is-deleted-the-board-is-the-only.md) | 2026-08-07 | accepted |
| 40 | [A board header condenses into a centred pill on reading](.agents/adr/0040-board-header-condenses-into-a-centred-pill.md) | 2026-08-07 | narrowed by 59 |
| 42 | [Rounds are the board's pages, flipped left and right](.agents/adr/0042-rounds-are-the-board-s-pages-flipped-left.md) | 2026-08-07 | accepted |
| 44 | ["A page board is never sent" is a browser rule, not a daemon rule](.agents/adr/0044-page-board-is-never-sent-is-a-browser.md) | 2026-08-07 | narrowed by 45 |
| 45 | [A page board may be awaited, and the caller declares it](.agents/adr/0045-page-board-may-be-awaited-and-the-caller.md) | 2026-08-07 | narrows 35 and 44; completed by 50 |
| 46 | [Commenting exists only where someone is waiting](.agents/adr/0046-commenting-exists-only-where-someone-is-waiting.md) | 2026-08-07 | narrows 35 |
| 47 | [The wait is 40 minutes, for every round, and the page shows what is left](.agents/adr/0047-wait-is-40-minutes-for-every-round-and.md) | 2026-08-07 | accepted |
| 50 | [A wait that dies is recorded on the round](.agents/adr/0050-wait-that-dies-is-recorded-on-the-round.md) | 2026-08-08 | completes 45 |
| 55 | [A stranded round is announced, not opened onto](.agents/adr/0055-stranded-round-is-announced-not-opened-onto.md) | 2026-08-09 | narrows 4; widened by 58; narrowed by 74 |
| 56 | [The launcher may compose a notification body, behind a filter](.agents/adr/0056-launcher-may-compose-a-notification-body-behind-a.md) | 2026-08-09 | narrows 19 |
| 57 | [The banner opens the board it names](.agents/adr/0057-banner-opens-the-board-it-names.md) | 2026-08-09 | narrows 72; narrowed by 75 |
| 58 | [One notifier for a round, and it is the daemon's](.agents/adr/0058-one-notifier-for-a-round-and-it-is.md) | 2026-08-09 | widens 55; narrowed by 73 |
| 59 | [The board clears its own chrome band, the artifact does not](.agents/adr/0059-board-clears-its-own-chrome-band-the-artifact.md) | 2026-08-09 | narrows 40 |
| 62 | [Third-party rendering code is vendored, not depended on](.agents/adr/0062-third-party-rendering-code-is-vendored-not-depended.md) | 2026-08-09 | accepted |
| 63 | [Code renders highlighted, six-hue, with the file's own line numbers](.agents/adr/0063-code-renders-highlighted-six-hue-with-the-file.md) | 2026-08-09 | narrowed by 64 |
| 64 | [A diff row suppresses syntax colour](.agents/adr/0064-diff-row-suppresses-syntax-colour.md) | 2026-08-09 | narrows 63 |
| 65 | [One tokenizer serves both a code block and a markdown fence](.agents/adr/0065-one-tokenizer-serves-both-a-code-block-and.md) | 2026-08-09 | accepted |
| 66 | [The owed-round dot takes a different hue in each theme](.agents/adr/0066-the-owed-round-dot-takes-a-different-hue-in-each.md) | 2026-08-09 | narrows 30 |
| 67 | [The pomodoro day runs 05:00 to 05:00, and its rollover ends the loop](.agents/adr/0067-the-pomodoro-day-runs-05-00-to-05-00-and.md) | 2026-08-10 | narrows 8; narrowed by 68 |
| 68 | [A session that must not start the timer marks itself](.agents/adr/0068-a-session-that-must-not-start-the-timer-marks.md) | 2026-08-10 | narrows 67 |
| 69 | [A conversation boundary is declared by the agent, and starts a new thread](.agents/adr/0069-a-conversation-boundary-is-declared-by-the-agent.md) | 2026-08-10 | accepted |
| 70 | [A page references its script and styles, content-addressed and never rewritten](.agents/adr/0070-a-page-references-its-script-and-styles-content-addressed.md) | 2026-08-10 | accepted |
| 71 | [The store is prunable by hand, and the promise not to prune it is dropped](.agents/adr/0071-the-store-is-prunable-by-hand-and-the-promise-is-dropped.md) | 2026-08-10 | relates to 70 |
| 72 | [The status item is a second process of the same bundle](.agents/adr/0072-status-item-is-a-second-process-of-the.md) | 2026-08-10 | replaces the deleted 9; narrowed by 57 |
| 73 | [Attended survives a look-away for two minutes](.agents/adr/0073-attended-survives-a-look-away-for-two.md) | 2026-08-10 | narrows 58 |
| 74 | [A round is announced once, and the mark outlives the absence](.agents/adr/0074-round-is-announced-once-and-the-mark.md) | 2026-08-10 | narrows 55 |
| 75 | [The bundle is an agent app, not a background-only one](.agents/adr/0075-bundle-is-an-agent-app-not-background.md) | 2026-08-10 | narrows 57; relates to 72 |
| 76 | [A launch that did not come from launchd refuses to supervise](.agents/adr/0076-no-argument-launch-refuses-to-supervise.md) | 2026-08-10 | relates to 75 |
| 77 | [The index polls for its rows](.agents/adr/0077-index-polls-for-its-rows.md) | 2026-08-10 | accepted |
| 78 | [The `select` message is deleted; a stage may propose, never decide](.agents/adr/0078-select-message-is-deleted-a-stage-may-propose.md) | 2026-08-01 | accepted |
| 79 | [The status item polls at the widget's cadence](.agents/adr/0079-status-item-polls-at-the-widget-s-cadence.md) | 2026-08-10 | relates to 77; relates to 72 |
| 80 | [The status item carries no colour](.agents/adr/0080-the-status-item-carries-no-colour.md) | 2026-08-10 | relates to 72; narrowed by 83, 84 |
| 81 | [The popover takes focus](.agents/adr/0081-the-popover-takes-focus.md) | 2026-08-10 | relates to 72; relates to 75 |
| 82 | [Forward and Restart preserve paused](.agents/adr/0082-forward-and-restart-preserve-paused.md) | 2026-08-10 | relates to 81 |
| 83 | [Paused says so with shape, not a number](.agents/adr/0083-paused-says-so-with-shape-not-a-number.md) | 2026-08-10 | narrows 80 |
| 84 | [One signal, one dimension, in the status glyph](.agents/adr/0084-one-signal-one-dimension-in-the-status-glyph.md) | 2026-08-10 | narrows 80; relates to 83 |
| 85 | [The tab carries one mark](.agents/adr/0085-the-tab-carries-one-mark.md) | 2026-08-10 | relates to 84 |
