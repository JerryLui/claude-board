# 118. Remote review rides an SSH tunnel; the daemon stays loopback-only

2026-09-28 · relates to 116

**Context:** the reviewer wants to answer boards from a MacBook while the sessions run on a Mac mini in the same office, and the daemon binds `127.0.0.1` and refuses any non-loopback `Host`; the alternative on the table was binding the office network and admitting the mini's hostname. **Decision:** the second Mac reaches the daemon through an SSH `LocalForward` to `127.0.0.1:7391` and browses it as `localhost:<port>`, logged in once a month through the existing handoff, so the daemon, its hostname gate and its origin checks are unchanged. **Consequences:** remote review works only while the tunnel is up and only where SSH reaches; `localhost` rather than `127.0.0.1` is the address because cookies are not port-scoped and the second Mac's own daemon already holds `127.0.0.1`'s; a network-listening mode is not built.
