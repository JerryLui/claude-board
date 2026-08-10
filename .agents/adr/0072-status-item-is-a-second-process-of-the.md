# 72. The status item is a second process of the same bundle

2026-08-10 · replaces the deleted entry 9; narrowed by 57

**Context:** entry 9 refused a menu bar item because a status item meant AppKit in
`bin/launcher.c` and a re-sign that risks the Documents grant. Two of its three premises have
since decayed: the daemon payload now ships *inside* the signature, so the ad-hoc hash already
moves on any source change, and entry 57 already admitted AppKit, `NSApplication` and a run loop
to this binary. What has not decayed is that the launcher supervises the daemon — it forks node
and blocks in `waitpid`, and is close to uncrashable.

**Decision:** the launcher forks a second child, `claude-board --menubar`, beside node — the same
self-spawn shape the `--notify` mode already uses, so it is the bundle's own `CFBundleExecutable`
and needs no second bundle, no second signature and no second LaunchServices record. The status
item is a pure client: no clock, no settings, no notification of its own, reading and driving the
daemon over loopback with the local secret. Measured before this was written: such a child's
status item is visible under today's `LSBackgroundOnly` plist, unchanged, whether launched from a
shell or bootstrapped by launchd.

**Consequences:** a crash in menu bar code kills the menu bar alone, and the supervisor's
fork/signal path gains one more child rather than becoming a run loop. Entry 9 is deleted rather
than narrowed — an entry reading "no `NSStatusItem`" while one exists is worse than no entry — but
its live half survives here: the Documents grant is still not spent on any capability buyable
another way, which is what entry 57 leans on. A second dedicated bundle was rejected for the
second permanent LaunchServices record it would cost (QUIRKS.md measured 6908, and a stale one
raises the "damaged and can't be opened" dialog).
