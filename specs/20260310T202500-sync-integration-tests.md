# Sync Integration Tests

## Goal

Add integration tests for `sync-handlers.ts` in `packages/server-remote` to verify that both workspace and document sync endpoints correctly handle the Yjs sync protocol: handshake, incremental updates, awareness, and broadcast.

## Context

The sync stack has good unit test coverage at the protocol layer (`@epicenter/sync`) and provider lifecycle layer (`@epicenter/sync-client`), but **zero tests** for the server-side message handler that actually dispatches sync messages, manages per-connection state, and broadcasts to peers.

`sync-handlers.ts` contains three pure functions: `handleWsOpen`, `handleWsMessage`, `handleWsClose`: that take a `Y.Doc`, `Awareness`, and `WebSocket` and return messages/state. These are the critical path: if they work, the DOs (which are thin wrappers around them + SQLite persistence) work.

## Approach

Test `sync-handlers.ts` directly with `bun:test` and a mock WebSocket. No need for Miniflare/vitest-pool-workers. The functions are framework-agnostic.

The Cloudflare `WebSocket` interface needed by sync-handlers: `.send()`, `.readyState`, `.close()`. We mock these minimally.

## Todo

- [x] Create `sync-handlers.test.ts` in `packages/server-remote/src/`
- [x] Test `handleWsOpen`: returns SyncStep1 + awareness states
- [x] Test `handleWsMessage`: SYNC messages (step1, step2, update)
- [x] Test `handleWsMessage`: AWARENESS messages (apply + broadcast)
- [x] Test `handleWsMessage`: QUERY_AWARENESS response
- [x] Test `handleWsClose`: cleans up listeners and awareness states
- [x] Test multi-client broadcast: update from client A reaches client B
- [x] Test full handshake: SyncStep1 → SyncStep2 → documents converge
- [x] Add `"test"` script to package.json
- [x] Run tests, verify all pass

## Non-goals

- Testing DO persistence (SQLite storage, compaction): requires Miniflare
- Testing auth middleware: separate concern
- Testing HTTP sync endpoint: the RPC `sync()` method is a thin wrapper around `decodeSyncRequest` + `Y.applyUpdateV2` + `Y.encodeStateAsUpdateV2`, all already tested at the protocol level

## Review

### Changes made

1. **`packages/server-remote/src/sync-handlers.test.ts`** (new): 22 tests across 7 describe blocks:
   - `handleWsOpen` (5 tests): initial messages, awareness inclusion, handler registration, echo prevention
   - `handleWsMessage: SYNC` (3 tests): SyncStep1→Step2 response, Step2 apply, Update apply
   - `handleWsMessage: AWARENESS` (2 tests): broadcast + flag, state applied to shared instance
   - `handleWsMessage: QUERY_AWARENESS` (2 tests): returns states when present, empty when none
   - `handleWsMessage: error handling` (2 tests): malformed binary error, unknown type passes through
   - `handleWsClose` (3 tests): handler unregistration, awareness cleanup, graceful empty close
   - `multi-client broadcast` (2 tests): update forwarding A→B, awareness broadcast
   - `full handshake convergence` (2 tests): one-way server→client sync, bidirectional merge

2. **`packages/server-remote/package.json`**: added `"test": "bun test"` script

### Decisions

- Used a minimal `MockWebSocket` class (captures `.sent` messages) instead of Miniflare, since `sync-handlers.ts` functions are pure and framework-agnostic.
- Discovered `wellcrafted/result` uses `null` for absent errors (not `undefined`): all assertions use `.toBeNull()`.
- Discovered `new Awareness(doc)` sets a default local state, so the "no awareness" test manually clears it with `setLocalState(null)`.
- Tests follow project conventions: `setup()` pattern, section headers, behavior-assertion names, `bun:test`.
