---
name: install
description: Install or update the claude-board daemon (runs the plugin's install.sh)
disable-model-invocation: true
---

# Install claude-board

Run the installer from this plugin's directory, in the foreground:

```sh
bash "${CLAUDE_PLUGIN_ROOT}/install.sh"
```

- Idempotent — also the update step: the daemon runs a copy of this code, so a plugin
  update changes nothing until this runs again.
- The transcript announces each macOS permission dialog before it blocks on one. Quote
  those lines to the user as they appear.
- Done when the success banner (`claude-board installed and running`) prints and the
  `verify` command under it answers. On a failed step, quote that step's lines verbatim
  and stop — the detail lines carry the fix.
