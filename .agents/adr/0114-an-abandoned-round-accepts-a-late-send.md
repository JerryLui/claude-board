# 114. An Abandoned round accepts a late Send

2026-09-10 · narrows 69; relates to 50, 107

**Context:** a `fresh` ask abandons the previous board's open rounds, and a reviewer mid-answer then met a refused Send and disabled widgets; nine typed answers were lost on 2026-09-09, while a merely Lapsed round had stored them all along. **Decision:** any round not yet Submitted stores a Send, Abandoned included; the round becomes Submitted, its widgets and Send render live, and a page board's queued comments flush on abandon as on lapse. **Consequences:** Abandoned now means only that the conversation moved on, and no thread waits on that board again, so the stored answer reaches an agent through `read` (115); the blocked `ask` is still released at once with `abandoned`.
