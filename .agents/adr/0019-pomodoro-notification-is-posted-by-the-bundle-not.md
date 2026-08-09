# 19. The pomodoro notification is posted by the bundle, not by osascript

2026-08-05 · narrowed by 56

**Context:** a notification's name, icon and System Settings row all come from the posting process's bundle, so `osascript` gave the pomodoro Script Editor's identity. **Decision:** `bin/notify.m` compiles into the launcher, which gains a `--notify <phase>` mode; `osascript` stays only for the bundle-less install. **Consequences:** the reader can set Alerts on claude-board's own row, paid for with a launcher that reads argv and one more permission prompt at install time.
