# Fix `attachSync` teardown: real `whenDisposed` barrier + stale-docstring correction

**Date**: 2026-04-20
**Status**: Draft
**Author**: AI-assisted (Braden + Claude)
**Branch**: `braden-w/document-primitive`
**Follows**: `specs/20260420T220000-simplify-definedocument-primitive.md`

## TL;DR

`attachSync.whenDisposed` resolves too early: the `ydoc.once('destroy')` handler calls `goOffline()` (a fire-and-forget `websocket.close()`) then resolves `whenDisposed` in a `finally` block: **before** the browser's async `ws.onclose` has run. Callers who `await whenDisposed` expecting the socket to be fully closed get a fake barrier. Fix by awaiting a one-shot `ws.addEventListener('close', …, { once: true })` inside the teardown before resolving. While here, fix the stale docstring in `define-document.ts` that tells users to call `sync.destroy()`: `SyncAttachment` exposes no such method.

## Motivation

### Current State

`packages/document/src/attach-sync.ts:461-473` (teardown):

```ts
ydoc.once('destroy', async () => {
  torn = true;
  try {
    ydoc.off('updateV2', handleDocUpdate);
    if (awareness) {
      awareness.off('update', handleAwarenessUpdate);
    }
    goOffline();        // ← calls websocket?.close(): fire-and-forget
    status.clear();
  } finally {
    resolveDisposed(); // ← resolves whenDisposed IMMEDIATELY
  }
});
```

`goOffline()` triggers `websocket.close()`, which sends a TCP FIN and transitions the socket to `CLOSING`. The socket reaches `CLOSED` only after `ws.onclose` fires asynchronously: typically on the next tick after the FIN round-trip (or immediately in testing environments without a real server).

Meanwhile `resolveDisposed()` fires **synchronously** in the `finally`, so `whenDisposed` resolves before the socket actually closes.

`SyncAttachment` surface (`attach-sync.ts:58-79`):

```ts
export type SyncAttachment = {
  whenConnected: Promise<void>;
  readonly status: SyncStatus;
  onStatusChange: (...) => () => void;
  reconnect: () => void;
  whenDisposed: Promise<void>;
};
```

Note: **no `destroy()` method exposed.** The attachment has no user-callable teardown path; teardown only happens via `ydoc.destroy()` cascade.

`define-document.ts:80-86` currently says:

```text
## y-websocket teardown gotcha

`ydoc.destroy()` fires `ydoc.on('destroy')` listeners. `IndexeddbPersistence`
registers one; `WebsocketProvider` does **not**. Your `[Symbol.dispose]`
must call `sync.destroy()` explicitly: relying on the `ydoc.destroy()`
cascade leaves sockets dangling.
```

This is wrong in two ways:
- `attachSync` **does** register `ydoc.once('destroy')` (at line 461). The cascade fires.
- `sync.destroy()` doesn't exist on the returned attachment. The doc is telling users to call a non-existent method.

### Problems

1. **Fake teardown barrier**: `await sync.whenDisposed` returns while the socket is still `CLOSING`. Callers doing destroy-then-recreate racing on the same URL see unpredictable behavior (new connection may race with old one's final close frame).
2. **Asymmetric with `attachIndexedDb`**: IDB's `whenDisposed` actually awaits `db.close()` (real promise). Sync's `whenDisposed` is a best-effort signal disguised as a barrier. Users assume symmetry; the types encourage it.
3. **Stale docstring**: `define-document.ts:80-86` instructs users to call `sync.destroy()`. The method doesn't exist. Users following the doc write code that errors at runtime (or worse, silently does nothing if guarded).
4. **No test coverage**: `define-document.test.ts` covers the cache primitive but there's no `attach-sync.test.ts` covering teardown ordering. The bug could regress silently.

### Desired State

- `sync.whenDisposed` resolves **only after** the WebSocket has actually reached `CLOSED` (or after a short timeout if `ws.onclose` never fires in degenerate environments).
- `define-document.ts` docstring reflects reality: the `ydoc.destroy()` cascade is the teardown path; no explicit `sync.destroy()` call is needed or available.
- A focused test file exercises teardown ordering, early-teardown, mid-backoff teardown, and double-destroy idempotence.

## Research Findings

### y-indexeddb vs y-websocket teardown semantics (verified via DeepWiki against `yjs/y-websocket`)

| Provider | Registers `ydoc.on('destroy')`? | Awaitable close? | `whenDisposed` honest? |
|---|---|---|---|
| `IndexeddbPersistence` | Yes (in constructor) | Yes: `db.close()` returns a promise | Yes: awaits the promise |
| `WebsocketProvider` | No | No: `ws.close()` is fire-and-forget | N/A: not exposed |
| **Our `attachSync`** | Yes (line 461) | **No**: `goOffline()` fire-and-forget | **No**: resolves in `finally`, before `onclose` |

Key finding: our `attachSync` already solves the cascade problem the Yjs finding warned about. It's **not** a direct port of `WebsocketProvider`, it's a custom implementation. The cascade is wired. The bug is one level deeper: we claim an awaitable barrier but don't honor it.

The fix is to bridge browser event → promise the same way `attachIndexedDb` does with the IDB promise.

### Blast radius of the fix

Grep for `attachSync(` across repo:

- `packages/document/src/attach-sync.ts`: the attachment itself.
- `packages/document/src/index.ts`: barrel export.
- Test files in `packages/document/src/`: none covering teardown.
- Zero production call sites. (Workspace layer uses its own parallel `createDocuments.ts`; apps don't call `attachSync` directly yet.)

Implication: we can change the teardown contract freely. No migrations needed.

## Design Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Where to fix | In `attachSync`, not per-caller | Contract-level fix. One place to get right. Matches `attachIndexedDb` idiom. |
| 2 | How to await `ws.onclose` | `await new Promise<void>(resolve => { if (ws.readyState === WebSocket.CLOSED) resolve(); else ws.addEventListener('close', () => resolve(), { once: true }); })` with a timeout safeguard | Browser standard. `{ once: true }` auto-removes listener. Idempotent if already closed. |
| 3 | Timeout for `ws.onclose` | 1000 ms | Real close handshakes complete in ms. A 1s cap catches servers that never respond to FIN. Logs a warning but still resolves: the caller's cleanup proceeds. |
| 4 | What happens if websocket never opened | Resolve immediately: no socket to wait for | `websocket` is `null` before first connect; early teardown is a legitimate path (user disposes before connect completes). |
| 5 | Mid-backoff teardown | Still works: `goOffline()` sets desired state, runloop exits, no socket to wait on | The supervisor loop already handles this correctly. Teardown just needs to let it exit. |
| 6 | Should `SyncAttachment` expose a public `destroy()` method? | **No.** Keep teardown via `ydoc.destroy()` cascade. | Users already call `ydoc.destroy()` in their builder's `[Symbol.dispose]`. Adding a second path creates two ways to do one thing. Match `attachIndexedDb` which also has no public `destroy()`. |
| 7 | Docstring fix in `define-document.ts` | Rewrite the "y-websocket teardown gotcha" section to describe actual behavior | Current text describes a non-existent API. Replace with a note that the cascade is wired correctly and `whenDisposed` is a real barrier. |
| 8 | Test coverage | New file `packages/document/src/attach-sync.test.ts` | Doesn't exist today. Needed to lock in the new contract. |

## Architecture

### Teardown flow: before

```text
  ydoc.destroy()
       │
       ▼
  'destroy' event fires
       │
       ▼
  handler runs:
  ┌────────────────────────────────────────┐
  │  goOffline()                           │
  │    └─ websocket?.close()  (fire & forget)
  │  status.clear()                        │
  │  finally: resolveDisposed()  ──────────┼─── whenDisposed resolves NOW
  └────────────────────────────────────────┘
              │
              │  (async, unrelated to whenDisposed)
              ▼
         ws.onclose eventually fires  ←─── socket actually closed here
```

### Teardown flow: after

```text
  ydoc.destroy()
       │
       ▼
  'destroy' event fires
       │
       ▼
  handler runs:
  ┌────────────────────────────────────────┐
  │  off listeners                         │
  │  goOffline()                           │
  │    └─ websocket?.close()               │
  │  status.clear()                        │
  │  await waitForClose(websocket, 1000ms) │
  │                 │                      │
  │                 │ listens for 'close'  │
  │                 │ resolves on close    │
  │                 │ times out w/ warn    │
  │                 ▼                      │
  │  resolveDisposed()  ───────────────────┼─── whenDisposed resolves AFTER close
  └────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Fix `attachSync` teardown

- [ ] **1.1** Add a helper `waitForWsClose(ws: WebSocket | null, timeoutMs: number): Promise<void>` at the bottom of `attach-sync.ts`. Resolves immediately if `ws` is null or already in `CLOSED` state; otherwise attaches a `{ once: true }` close listener and races against a `setTimeout` (clears on resolve).
- [ ] **1.2** Update the `ydoc.once('destroy', …)` handler at lines 461-473: make it async-await `waitForWsClose(websocket, 1000)` after `goOffline()`, before `resolveDisposed()`.
- [ ] **1.3** Confirm `websocket` is captured in the closure properly: since `websocket` can be reassigned across reconnects, we need to capture the current reference at teardown time, not a stale one. Verify by re-reading how `websocket` is managed in the supervisor loop.
- [ ] **1.4** On timeout, log `console.warn('[attachSync] WebSocket did not fire onclose within 1000ms; resolving whenDisposed anyway')` and still resolve.

### Phase 2: Fix stale docstring in `define-document.ts`

- [ ] **2.1** Replace the "y-websocket teardown gotcha" section (lines 80-86) with accurate text. Suggested content:

  ```text
  ## Provider teardown

  Attachments like `attachIndexedDb` and `attachSync` register `ydoc.once('destroy')`
  internally, so `ydoc.destroy()` in your `[Symbol.dispose]` cascades teardown to every
  provider. Each provider's `whenDisposed` promise resolves only after its real cleanup
  completes (IDB `db.close()`; WebSocket `onclose` fires, with a 1s fallback). Aggregate
  them in your bundle's `whenDisposed` for a real teardown barrier.
  ```
- [ ] **2.2** Verify no other JSDoc comments in `packages/document/src/` reference `sync.destroy()`. Grep and remove any stragglers.

### Phase 3: Test coverage

- [ ] **3.1** Create `packages/document/src/attach-sync.test.ts`.
- [ ] **3.2** Scenario: **ordering**. Construct a doc with `attachSync`. Connect to a mock WS server. Call `ydoc.destroy()`. Verify `whenDisposed` does not resolve until after the mock server's close ack: or, if mocking is hard, verify that `ws.readyState === WebSocket.CLOSED` by the time `whenDisposed` resolves.
- [ ] **3.3** Scenario: **before connect**. Construct + immediately destroy before the supervisor loop wakes. `whenDisposed` should resolve quickly (no socket).
- [ ] **3.4** Scenario: **mid-backoff**. Simulate failed connections so the supervisor is in backoff. Call destroy. `whenDisposed` resolves; no leaks.
- [ ] **3.5** Scenario: **double destroy**. Call `ydoc.destroy()` twice. `whenDisposed` still resolves exactly once; no errors logged.
- [ ] **3.6** Scenario: **timeout fallback**. Simulate a WS that never fires `onclose` (e.g., mock with a swallowed close). `whenDisposed` resolves within ~1s with a `console.warn`.

### Phase 4: Verification

- [ ] **4.1** `bun test` in `packages/document`. New tests pass. Existing tests still pass.
- [ ] **4.2** `bun run build` at repo root. No type errors.
- [ ] **4.3** Grep `packages/` for `sync.destroy()`: zero results (never was a real method).
- [ ] **4.4** Grep `packages/document/src/` for the old "y-websocket teardown gotcha" phrasing: zero results.

## Edge Cases

### Early destroy (before first connect)

1. `new Y.Doc()` + `attachSync(ydoc, …)` → supervisor's `void (async () => { await config.waitFor; … })()` begins.
2. User calls `ydoc.destroy()` before `runLoop()` creates the first WebSocket.
3. `torn = true`; `websocket` is still `null`. `waitForWsClose(null, …)` resolves immediately.
4. `whenDisposed` resolves quickly. No socket leaked because none was created.

### Double `ydoc.destroy()`

1. First call: `'destroy'` event fires, handler runs, `whenDisposed` eventually resolves.
2. Second call: Y.Doc is already `isDestroyed`; `'destroy'` doesn't re-fire (Yjs guards this). Our handler registered with `once` is already removed.
3. No double-resolve of `whenDisposed` (Promise resolvers are idempotent by language spec).

### WebSocket in `CONNECTING` state at destroy

1. Socket in `CONNECTING`: `ws.readyState === 0`.
2. `ws.close()` transitions to `CLOSING`, then `CLOSED` (browser short-circuits; the `open` event is skipped).
3. `onclose` fires. Our `waitForWsClose` resolves.

### WebSocket replaced mid-teardown

1. Supervisor runloop creates WS instance A. User calls `destroy`.
2. `torn = true`. Handler captures current `websocket` reference (A), awaits its close.
3. Even if the supervisor would otherwise advance and create WS instance B, `torn` gates it: no new socket created.
4. Safe.

### Server hangs on close frame

1. Misbehaving server receives FIN but never sends FIN-ACK. `onclose` fires only after browser timeout (varies by browser, typically 30+s).
2. Our 1000ms timeout kicks in; `console.warn` logged; `whenDisposed` resolves.
3. Caller proceeds with their cleanup. TCP stack will eventually reap the connection.

## Open Questions

1. **Timeout duration: 1000 ms?**
   - Options: (a) 500 ms: aggressive, matches typical close RTT on localhost; (b) 1000 ms: comfortable for most real servers; (c) 5000 ms: very lenient, but ties up teardown.
   - **Recommendation**: 1000 ms. Real close handshakes are <100 ms on any healthy connection; 1 s is forgiving without blocking teardown visibly.

2. **Should the timeout be configurable via `SyncAttachmentConfig`?**
   - **Recommendation**: Defer. Hardcode 1000 ms for now. Add an `onCloseTimeoutMs` opt only if a caller demonstrates a need.

3. **Should `whenDisposed` reject (instead of resolve + warn) on timeout?**
   - Options: (a) resolve with a warn: forgiving, doesn't break callers; (b) reject: honest about the failure, but breaks `Promise.all(...).then(() => {})` chains.
   - **Recommendation**: (a). Callers `await whenDisposed` as a barrier, not as a success signal. Rejecting creates an unhandled-rejection gotcha. The warn surfaces the issue.

4. **Does `attach-sync.test.ts` need a mock WebSocket or can we use Node's `ws` module?**
   - **Recommendation**: Check how other tests in the repo handle this. If there's an existing pattern (mock WS class or real loopback server), use it. Otherwise a small mock class is fine.

## Success Criteria

- [ ] `packages/document/src/attach-sync.ts:461-473` awaits `ws.onclose` (with timeout) before resolving `whenDisposed`.
- [ ] `packages/document/src/define-document.ts:80-86` docstring replaced with accurate text describing the real teardown cascade.
- [ ] `packages/document/src/attach-sync.test.ts` exists and passes with five scenarios covered.
- [ ] `bun test` passes in `packages/document`.
- [ ] `bun run build` at repo root passes.
- [ ] Grep for `sync.destroy()` returns zero results in `packages/`.
- [ ] `SyncAttachment` type surface unchanged (no new public methods; this is a contract-fidelity fix, not an API expansion).

## Non-Goals

- **Redesigning the sync protocol.** Teardown only.
- **Exposing a public `destroy()` on `SyncAttachment`.** The cascade is the only path.
- **Making `ws.close()` synchronous.** Impossible in browser. We're awaiting `onclose`, not bypassing it.
- **Fixing any other attachment.** `attachIndexedDb` already does this right.

## References

### Files modified

- `packages/document/src/attach-sync.ts`: teardown handler + new `waitForWsClose` helper
- `packages/document/src/define-document.ts`: docstring replacement (lines 80-86)

### Files created

- `packages/document/src/attach-sync.test.ts`: five teardown scenarios

### Prior art

- `packages/document/src/attach-indexed-db.ts`: the reference pattern for honest `whenDisposed`
- Yjs DeepWiki investigation notes (see `specs/20260420T220000-simplify-definedocument-primitive.md` Research Findings for original findings)
