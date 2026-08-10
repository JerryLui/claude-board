# 83. Paused says so with shape, not a number

2026-08-10 · relates to 80

**Context:** a paused Timer went on displaying its frozen countdown in the menu bar title and in the Popover's status line, which reads as a clock that has stopped working rather than one deliberately stopped, and states the same fact twice once the glyph already says it. **Decision:** neither native surface shows a time while paused — the menu bar title is empty and the status line names the phase alone — and paused is drawn instead, as its own treatment of the phase glyph. The index page's dial keeps its number, having room for it. **Consequences:** the glyph becomes the only paused signal in the menu bar, so it has to be a shape difference and not another weight of the same grey, opacity already meaning "the daemon has stopped answering"; and the two native surfaces now diverge from the browser widget on purpose rather than by omission.
