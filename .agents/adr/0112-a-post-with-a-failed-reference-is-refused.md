# 112. A post with a failed reference is refused

2026-09-03 · relates to 3; widened by 117

**Context:** a reference that failed to resolve still landed, as a "Could not resolve" box on the reviewer's page, while the post returned 200 and the packet carried no blocks, so the agent never learned and the reviewer was the one who saw it; on a question round the agent got nothing back until submit. **Decision:** a post carrying any reference that fails to resolve is refused whole, with one message per failed reference that names the project directory, the reference roots in force, and the ways out (a relative path for a project file, a root added through `CLAUDE_BOARD_REF_ROOTS` and a rerun of the installer, by value until then), and that never says whether a file exists outside the boundary. **Consequences:** the block-level `error` stays only for what an already-stored board carries; a round with one typo costs the agent a re-post rather than costing the reviewer a broken page.
