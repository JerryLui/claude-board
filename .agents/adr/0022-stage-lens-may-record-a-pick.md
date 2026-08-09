# 22. The stage lens may record a pick

2026-08-05

**Context:** a variant option's stage is inert so that only a real reviewer click can record a pick, and the lens added for readable size makes that same stage live. **Decision:** the lens carries a control that picks the option it was opened from and closes in the same act, naming that option in chrome outside the framed stage. **Consequences:** the residual risk is a mock drawing convincing fake chrome rather than the stage pressing anything (`test/check-stage-isolation.mjs`).
