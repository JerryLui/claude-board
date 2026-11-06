# 148. At most eight sessions work at once, twelve alive

2026-11-06, amends 129

**Context:** the cap of six working (129) was a default borrowed from `/direct`'s cap of 6 owners and the memory budget. A memory read on the 32 GB Mac on 2026-11-06 showed 18 Claude sessions holding about 11.5 GB (400 to 850 MB each), 6 GB free and swap 4.0 of 5 GB used. **Decision:** `MAX_WORKING` is 8, the PM's pick, and `MAX_ALIVE` stays 12. Rejected: twelve working, too much for that memory and for the heavy gate every session shares. **Consequences:** the Master Chief's rule and `~/.claude/scripts/board-wait.mjs` each hold the number too, and a queued mission's wake fires once per free slot, so those two land together, after `./install.sh` has put the new cap in the running daemon.
