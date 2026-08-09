# 14. The launcher is compiled from a staged copy; the stamp covers the binary

2026-08-04

**Context:** a quoted `#include` searches its own directory first, so a `launcher_paths.h` dropped into `bin/` shadowed the generated header and was signed into the granted bundle, invisibly in `git status`. **Decision:** `install.sh` compiles a staged copy with `-iquote`, warning non-fatally about a header left in the clone, and the stamp gains the sha256 of the installed executable. **Consequences:** identical inputs still report "already current", so the TCC grant survives a routine reinstall.
