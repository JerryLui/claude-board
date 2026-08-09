# 56. The launcher may compose a notification body, behind a filter

2026-08-09 · narrows 19

**Context:** entry 19's launcher lets argv select a row of a compiled-in table and name a sound, but never supply a word that is shown, deliberately, because it holds the reader's Documents grant and the plist that spawns it is user-writable; a banner that cannot name which project wants you is close to useless once more than one session runs. **Decision:** the launcher gains one format slot, filled only by an argument passing a strict name pattern in C, the same shape `is_safe_cue_name` already applies to a cue; an argument that fails the pattern selects the unnamed sentence instead of being rejected. **Consequences:** "no byte of argv reaches the screen" is given up and replaced by "no byte reaches the screen unfiltered", so the pattern is now load-bearing and belongs with the cue filter in review; a project name outside it degrades silently rather than failing loudly.
