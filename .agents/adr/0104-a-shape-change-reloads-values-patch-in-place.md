# 104. A shape change reloads the page; values patch in place

2026-08-12 · relates to 103

**Context:** the index page's shape — which fields and surfaces exist — is server-rendered once per `GET /`, and the Master switch joined the store prune in going stale the moment a write changed it. **Decision:** a successful write that changes the page's shape repairs with `location.reload()`, plus at most a one-shot flag that puts the reviewer back where they were (the settings panel reopening after a Master-switch flip); only values inside a fixed shape patch in place. A client-side second rendering path was rejected. **Consequences:** no hidden alternate shapes in the DOM and no shape logic duplicated client-side; every shape flip costs a visible reload, and a failed write must stay visibly failed rather than reload.
