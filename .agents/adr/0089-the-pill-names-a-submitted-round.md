# 89. The pill names a Submitted round

2026-08-11 · narrows 40; relates to 50

**Context:** the header pill printed the bare word `read-only` for three different situations — a round never Awaited, a Lapsed one, and one the reviewer had just Submitted — so the surface answered "can I be heard here" and never "did my answer land", and a reviewer who had just sent a round was told only what they could no longer do. **Decision:** a Submitted round's pill says `submitted`; never-Awaited and Lapsed rounds both keep `read-only`, because to a reader they mean the same thing. **Consequences:** the pill's slot now carries two closed-state names instead of one, and the never-Awaited/Lapsed distinction ADR 50 deliberately kept in the data stays invisible in the interface, on purpose rather than by omission.
