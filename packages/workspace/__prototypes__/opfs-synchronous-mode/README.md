# OPFS synchronous-mode prototype

Question: with Epicenter's real `@sqlite.org/sqlite-wasm` `opfs` VFS and
`journal_mode = DELETE`, does `synchronous = EXTRA` work reliably, and what
commit-latency cost does it add over `FULL`?

Run from the repository root:

```sh
bun packages/workspace/__prototypes__/opfs-synchronous-mode/run.ts
```

This throwaway prototype starts a cross-origin-isolated local page, runs SQLite
inside browser Workers, and uses scratch OPFS databases. It measures transaction
latency, terminates a Worker immediately after each acknowledged commit, opens
the database in a new Worker, checks the marker, and runs
`PRAGMA integrity_check`.

The harness tests SQLite commit acknowledgement and abrupt Worker loss. It also
kills and relaunches Chromium against one persistent profile to exercise
browser-process loss. It does not simulate operating-system failure or physical
power loss. Passing therefore cannot prove the extra power-loss guarantee
described by SQLite. See `NOTES.md` for the latest result and provisional
decision.
