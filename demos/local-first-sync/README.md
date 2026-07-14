# Local-first sync demo + benchmark (throwaway)

Disposable investigation artifact, 2026-07-11. Not production code; do not
extend it in place. The decision it supports lives in `DECISION-MEMO.md`.

## Layout

- `shared/protocol.ts` — the minimal cell-op sync protocol (push/pull/poke)
- `server/main.ts` — canonical Bun server; SQLite oplog per principal;
  authoritative by acceptance order; `--mode hosted|selfhost`
- `client/` — browser notes app: complete local SQLite/OPFS database in a
  worker, outbox, WS poke → pull, lazy Yjs bodies stored in the same DB
- `proofs.ts` — executable proofs of the 12 product-contract properties
- `bench/` — same-browser benchmark: whole-row YKV vs per-cell Yjs vs
  SQLite/OPFS, plus a manual device harness
- `bench-results.json` / `bench-results.md.log` — raw output from the last run

## Run

```sh
bun install                      # once, inside this directory
bun run dev                      # vite on :5199 (leave running)

# the 12 proofs (spawns/kills its own servers on :8788/:8789)
bun proofs.ts

# interactive demo: canonical server + two "devices"
bun server/main.ts --mode hosted
# open http://localhost:5199/client/notes.html?profile=A
# open http://localhost:5199/client/notes.html?profile=B   (second browser
#   profile/private window = second device; OPFS is single-handle per origin)
# old-client simulation: ...?profile=C&appver=1
# schema-mismatch simulation: ...?profile=D&schemamajor=1

# benchmark matrix (Playwright Chromium; writes bench-results.*)
bun bench/runner.ts --rows 1000,10000,50000

# manual device harness (Safari / iPhone): open on the device
# http://<host>:5199/bench/sqlite.html?autorun&rows=10000
# (also ykv.html / percell.html; page reseeds, reloads, prints results)
```

## Known demo-grade shortcuts

Documented in the memo's production-gap list: no rebase of pending ops
(transient flicker until convergence), single pull page cap, bearer==principal
auth, no oplog compaction/snapshot bootstrap, `opfs-sahpool` = one tab per
origin, LIKE search instead of FTS5.
