# 77. The index polls for its rows

2026-08-10 · accepted

**Context:** the index is rendered once and its only client script re-labels relative times, so a board posted after the page loaded never appears and a status pill can be arbitrarily stale, while the board page already has an SSE hub that could push the same news instantly. **Decision:** the index fetches its rows on the fifteen-second tick it already runs and patches the list in place, rather than subscribing to a stream or reloading the page, so that scroll position and the search box survive an update as a reload would not. **Consequences:** the index can be up to one tick behind, which is the trade for not giving a page nobody stares at a live connection per tab, and the daemon owes a rows endpoint cheap enough to answer on that interval for every open index.
