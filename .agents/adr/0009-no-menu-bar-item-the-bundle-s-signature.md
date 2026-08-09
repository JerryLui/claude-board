# 9. No menu bar item — the bundle's signature is load-bearing

2026-08-04 · narrowed by 57

**Context:** a menu bar countdown looks nearly free in an always-on tool that already ships a macOS app bundle. **Decision:** no `NSStatusItem` and no AppKit in `bin/launcher.c`; the pomodoro surfaces are a boundary notification and an index widget. **Consequences:** the always-visible glance is given up rather than re-sign gratuitously and risk the TCC Documents grant; a second dedicated bundle is the shape to revisit.
