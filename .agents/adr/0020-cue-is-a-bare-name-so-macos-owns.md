# 20. The cue is a bare name, so macOS owns the cue

2026-08-05

**Context:** why a cue the daemon plays itself is not an option: DESIGN.md. **Decision:** the cue is a bare name resolved where it already lives — `soundNamed:` on the bundled path, AppleScript's `sound name` on the clone path, the same names either way — and `SOUNDS_DIRS` holds both `/System/Library/Sounds` and `~/Library/Sounds`, unioned by `cueNames()` and walked by `cuePath()` in the order QUIRKS.md measures macOS to prefer, so a reader can add a gong. **Consequences:** every macOS notification control reaches the cue; `src/cues.mjs` enumerates the directories macOS resolves against, so there are not two lists to keep in sync; the `cueNames()` memo carries a 5s TTL; and a name present in both directories resolves to the system copy, so a reader who shadows a stock sound never hears their file. The daemon still writes nothing. The staging measurement: QUIRKS.md.
