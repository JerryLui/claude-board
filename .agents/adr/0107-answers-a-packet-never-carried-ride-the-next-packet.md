# 107. Answers a packet never carried ride the next packet

2026-08-17 · widens 35; relates to 50

**Context:** a submit on a round whose wait already died is persisted (a lapsed round stays `open`, 35 and 50) but never reaches the agent — that round can never hand out a packet again, and "one packet is one round" stops any later one carrying it; the agent keeps a `timeout` packet claiming a no-response the store has since falsified. **Decision:** generalise 35 from comments to answers — a `sent` round whose answers no packet has carried has them appended to the next packet the same thread returns, once, keyed on a delivered mark rather than on round shape or timing. **Consequences:** the packet gains a second documented exception and a board gains a daemon-only `answersDelivered` ledger; a board written before it adopts its history rather than paying it out, so a thread in flight across an upgrade is not replayed.
