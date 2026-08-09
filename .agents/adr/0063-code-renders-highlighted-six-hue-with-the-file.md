# 63. Code renders highlighted, six-hue, with the file's own line numbers

2026-08-09

**Context:** `renderCodeBlock` emitted plain escaped text, and `block.lang` was computed and then spent on kicker text. **Decision:** highlight server-side at post time, emitting classes and never inline colour so the theme toggle re-colours archived boards for free; adopt a six-hue palette (keyword, string, function, number, comment, base) as twelve new tokens across `DARK` and `LIGHT`; and number rows with the file's real line numbers from `source.lines` in a non-selectable gutter. **Consequences:** the "one accent plus semantic status colours" discipline no longer describes the code surface, and every new token owes `test/check-contrast.mjs` a 4.5:1 assertion against `--panel-2` in both themes.
