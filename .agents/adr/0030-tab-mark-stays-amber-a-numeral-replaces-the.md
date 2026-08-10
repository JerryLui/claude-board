# 30. The tab mark stays amber; a numeral replaces the inverted tile

2026-08-06 · narrowed by 66

**Context:** why the mark takes `DARK['--warning']`, and why not an SVG data URI: DESIGN.md. **Decision:** pending keeps the page's own amber tile and draws a bold ink numeral onto it with canvas `fillText`, stepping 22/18/17px for one digit, two digits and the `9+` overflow. **Consequences:** ink mass rather than tile colour is the whole signal, and a canvas or font failure returns null, so the tab keeps the mark it already had; the brand permanently shares a hue with a state colour, so a `--warning` retune moves it silently, and the explicit `DARK` naming must survive since light's `#805300` renders as mud.
