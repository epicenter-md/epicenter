# Remote action dispatch: calling actions on a peer device

**Date:** 2026-04-25
**Status:** shipped. Supersedes the `invoke()` shape in `specs/20260425T000000-device-actions-via-awareness.md`.
**Depends on:** `specs/20260425T200000-actions-passthrough-adr.md` (shipped)
**Supersedes:** the `invoke()` proposal in `specs/20260425T000000-device-actions-via-awareness.md`
**Revisions:** v2 (curried API critique); v3 (post-collapse pass: see "Final design" below); v4 (further collapse: `dispatch:` removed entirely from `attachSync`; `RemoteCallOptions` aligned to `{ timeout? }` only).

---

## Final design (post-collapse pass, 2026-04-25)

The body of this spec describes the v2 design (three layers: `createRemoteProxy`, `createRemoteCaller`, awareness convention). After working through the design with Braden, **the v2 layering was collapsed**. This section is the source of truth; the rest of the spec is preserved as historical context for the reasoning.

### Public API: one function

```ts
import { peer } from '@epicenter/workspace';
import type { TabManagerActions } from '@epicenter/tab-manager';

const macbook = peer<TabManagerActions>(fuji.sync, 'macbook-pro');
const result = await macbook.tabs.close({ tabIds: [1] }, { timeout: 5_000 });
// Promise<Result<{ closedCount }, RpcError>>

if (result.error) toast.error(extractErrorMessage(result.error));
else toast.success(`closed ${result.data.closedCount} tabs`);
```

`peer<T>(sync, deviceId)` is the app-facing public surface. Returns a typed JavaScript Proxy. Every leaf is `(input?, options?) => Promise<Result<T, RpcError>>`. The proxy is stateless: each call resolves the deviceId against awareness and dispatches via `sync.rpc`.

### What was collapsed from v2

| v2 had | Final has | Why |
|---|---|---|
| 3 layers (`createRemoteProxy` / `createRemoteCaller` / awareness convention) | 1 function (`peer`) + awareness convention | The "primitive for custom transports" had zero real consumers; mocking `sync.rpc` directly works for tests; HTTP fallback is speculative |
| `RemoteTarget = { deviceId } \| { deviceName } \| { clientId }` discriminator | `string` (deviceId only) | Fuzzy name matching and clientId addressing are speculative; one form, one resolver |
| `--peer device.<field>=<value>` CLI query DSL | `--peer <deviceId>` plain string | DSL implied extensibility we won't ship; mirrors awareness shape and silently breaks on rename |
| `prefer: 'unique' \| 'any'` option, `RpcError.AmbiguousPeer` variant | First-match-wins, no ambiguity error | Per-installation deviceId convention makes collisions cryptographically unreachable |
| Dot-prefix CLI sugar (`epicenter run mac.tabs.close`) | Only `--peer` form | Two ways to do the same thing; dot-prefix has implicit fallback ambiguity (peer vs workspace export) |
| Two awareness top-level keys (`device`, `offers`) | One key (`device.offers`) | Always written together at boot, never partially updated |
| `createRemoteCaller(workspace).peer<T>(target)` two-step | `peer<T>(sync, deviceId)` one-step | Intermediate `RemoteCaller` noun has no other callers; sync is always in scope |
| `dispatch:` callback on `attachSync` | `actions:` data on `attachSync` | All apps had identical `(p, i) => dispatchAction(actions, p, i)` boilerplate; idiomatic precedent (tRPC, gRPC, Comlink) is data not callbacks; wrapping (auth/audit) becomes upstream tree composition |

### The deviceId convention (load-bearing for first-match-wins)

`deviceId` MUST be a per-installation nanoid stored in platform-appropriate persistent storage. Two browser tabs of the same SPA share storage → share deviceId → are interchangeable runtimes (first-match correct). Two physical devices have distinct nanoids (no collision). Hardcoded deviceIds are an anti-pattern that breaks the invariant.

The framework ships `getOrCreateDeviceId(storage: SimpleStorage): string` for the common case:

```ts
import { getOrCreateDeviceId } from '@epicenter/workspace';

// In each app's iso entry:
const deviceId = getOrCreateDeviceId(localStorageAdapter);
```

`SimpleStorage` is a sync `{ getItem, setItem }` shape: same pattern as auth's `SessionStore`. Adapters land next to the storage they wrap (localStorage in svelte-utils, chrome.storage with `whenReady` in tab-manager, tauri-plugin-store wrapper in apps that need it).

### Awareness publishing (PR-D side)

```ts
import {
  attachAwareness, attachEncryption,
  standardAwarenessDefs, actionManifest, getOrCreateDeviceId,
} from '@epicenter/workspace';

const awareness = attachAwareness(ydoc, { ...standardAwarenessDefs });
const actions = createFujiActions(tables);
awareness.setLocal({
  device: {
    id: getOrCreateDeviceId(storage),
    name: 'Braden MacBook',
    platform: 'tauri',
    offers: actionManifest(actions),
  },
});
```

`actionManifest(actions)` walks the action tree and returns `Record<dotPath, { type, input?: JSONSchema, title?, description? }>`. JSON Schema is full (not path-only) so the discovery use case (mobile UI builds a form for a remote action) works without an additional fetch.

### Discovery

```ts
// Snapshot
const peers = fuji.awareness.peers();   // Map<clientId, { device }>
for (const [clientId, state] of peers) {
  if (!state.device) continue;
  console.log(`${state.device.name} (${state.device.platform}): ${state.device.id}`);
  for (const path of Object.keys(state.device.offers ?? {})) console.log(`  - ${path}`);
}

// Reactive (existing API)
fuji.awareness.observe((changes) => { /* added / removed / updated */ });
```

CLI: `epicenter peers` (already shipped) lists devices with deviceId prominent for copy-paste.

### Resolver

```ts
export function resolvePeer(
  awareness: Awareness,
  deviceId: string,
): Result<number, RpcError.PeerNotFound>;
```

Walks `awareness.getStates()` in clientId-ascending order; returns the first match. Single function, used by both `peer()` proxy and the CLI's `--peer` flag.

### Disconnect-aware short-circuit

`peer()` keeps a `Map<clientId, Set<PendingCall>>` and subscribes to awareness `removed` events. When a clientId disappears with pending calls, those promises reject with `RpcError.PeerLeft` immediately, no waiting for the `timeout` to fire.

### CLI surface

```bash
epicenter peers                                                    # discovery
epicenter run --peer macbook-pro tabs.close --json '{...}'         # remote dispatch
epicenter run tabs.close --json '{...}'                            # local
```

One form for remote (`--peer <deviceId>`), no dot-prefix sugar, no `device.<field>=<value>` query DSL.

### Out of scope (deferred until a real consumer asks)

- **Auth / per-action authorization gates**: the workspace room is the auth boundary in v1.
- **Fan-out** (`peer.all<T>(workspace).action(...)`): speculative.
- **`{ clientId }` direct addressing**: no real use case identified.
- **Per-action timeout in metadata**: caller passes `{ timeout }` per call.
- **Lazy schema fetch on demand**: full schema in awareness for v1; revisit if payload is a problem.
- **Custom transports / HTTP fallback**: speculative; reintroduce `createRemoteProxy(send)` as an unexported helper-promotable-to-public if a real case shows up.

### Execution

See `specs/20260426T000000-execution-prompt-device-actions-and-remote-dispatch.md` for the eight-commit execution plan.

---

## Historical: v2 design (preserved for reasoning trail)


## TL;DR

Three layers, each earning its keep:

1. **Primitive: `createRemoteProxy<TActions>(send)`**: generic-only typing, JavaScript Proxy at runtime. Pure functional core: type variable + a single `send` callable, no awareness, no sync, no workspace. The escape hatch for callers who want their own routing.

2. **Convenience: `createRemoteCaller(workspace)` → `caller.peer<TActions>(target)`**: curried. Workspace bound once (lifetime matches workspace). Target per peer. Each leaf accepts per-call `{ timeout, signal }` options.

3. **Standard awareness convention**: `device` and `offers` keys, opt-in by spreading into `attachAwareness` defs. `serializeActionManifest(actions)` populates `offers`.

Call sites:

```ts
// shared types
import type { TabManagerActions } from '@epicenter/tab-manager';

// at workspace construction
const remote = createRemoteCaller(workspace);

// per-peer, anywhere
const bob = remote.peer<TabManagerActions>({ deviceId: 'bob-nanoid' });
const result = await bob.tabs.close({ tabIds: [123] }, { timeout: 30_000 });
// result: Result<{ closedCount }, BrowserApiFailed | RpcError>
```

The lower-level form is callable directly when you want full control:

```ts
const remote = createRemoteProxy<TabManagerActions>(async (path, input, options) => {
  // your own routing: auth wrapping, audit log, HTTP fallback, mock for tests
  return mySend(path, input, options);
});
```

## What exists today

| Piece | Status |
|---|---|
| `sync.rpc(clientId, action, input, { timeout })` | Implemented end-to-end |
| `RpcActionMap` / `DefaultRpcMap` / `InferSyncRpcMap<A>` | Implemented |
| `createRemoteActions(actions, send)` (runtime tree walk) | Implemented; **deleted in this proposal**: redundant with `createRemoteProxy` |
| `attachAwareness(ydoc, defs)` typed wrapper | Implemented |
| Standardized `device` / `offers` awareness keys | **Not implemented: spec only** |
| `serializeActionManifest(actions)` | **Not implemented** |
| `createRemoteProxy<TActions>(send)` | **Not implemented** |
| `createRemoteCaller(workspace)` | **Not implemented** |
| `RpcError.AmbiguousDeviceId` / `WorkspaceDisposed` variants | **Not implemented: additions needed in `@epicenter/sync`** |
| Tab-manager publishes `{ deviceId, client }` ad-hoc | True today; migrates to `device` + `offers` + `client` |

## Why curry: answering the API critique

The original proposal took `{ sync, awareness, target }` as a single bag at every peer construction. That was wrong:

- **`sync` and `awareness` are co-owned by definition** (both belong to the same workspace). Two args invites swapping them or pairing across workspaces. Wrap them.
- **Workspace lifetime ≠ peer lifetime.** A UI rendering a peer list constructs N proxies churning every awareness tick. Five peers = five identical closures over identical `sync`/`awareness`. Curry the deps once.
- **Industry patterns curry.** tRPC's `createTRPCClient<AppRouter>({ links })`, gRPC-Web stubs, Apollo's `client.query({}, { context })`: all bind transport once, route per-call. The proposed shape was idiosyncratic.

The curried API:

```ts
const remote = createRemoteCaller(workspace);   // workspace bound once
const bob = remote.peer<TabManagerActions>({ deviceId: 'bob' });
const alice = remote.peer<TabManagerActions>({ deviceId: 'alice' });
```

Each `peer()` call constructs a Proxy parameterized by the target. The Proxy closes over `remote` (which holds the workspace), so all peers share infrastructure but have their own target.

## API: full surface

### `createRemoteProxy<TActions>(send)`: primitive

```ts
// packages/workspace/src/rpc/remote-proxy.ts

export type RemoteSendOptions = {
  timeout?: number;
  signal?: AbortSignal;
};

export type RemoteSend = (
  path: string,
  input: unknown,
  options?: RemoteSendOptions,
) => Promise<unknown>;

export function createRemoteProxy<TActions extends Actions>(
  send: RemoteSend,
): RemoteActions<TActions>;
```

Implementation: JavaScript `Proxy` over a function target. Property access returns a child proxy with the path extended. Function call routes through `send(dotPath, input, options)`, then `isResult(raw) ? raw : Ok(raw)` at the leaf, `Err(ActionFailed)` on throw.

`RemoteActions<A>` is the existing mapped type from the passthrough ADR's `WrapAction<F>` 4-branch conditional. Each leaf becomes:

```ts
(...args: HandlerArgs, options?: RemoteSendOptions) => Promise<Result<T, E | RpcError>>
```

The `options?` parameter is appended to the handler's args. Type: `Parameters<F>` plus optional `RemoteSendOptions`.

### `createRemoteCaller(workspace | deps)`: convenience

```ts
// packages/workspace/src/rpc/remote-caller.ts

// Convenience overload: take a workspace
export function createRemoteCaller(workspace: {
  sync: Pick<SyncAttachment, 'rpc' | 'whenDisposed'>;
  awareness: Pick<Awareness<any>, 'getAll'>;
}): RemoteCaller;

// Low-level overload: take adapters
export function createRemoteCaller(deps: RemoteCallerDeps): RemoteCaller;

export type RemoteCallerDeps = {
  peers: () => Iterable<[clientId: number, state: PeerState]>;
  rpc: (
    clientId: number,
    action: string,
    input: unknown,
    options?: RemoteSendOptions,
  ) => Promise<Result<unknown, RpcError>>;
  whenDisposed?: Promise<unknown>;
};

export type PeerState = {
  device?: { id: string; name: string; platform?: string };
  offers?: Record<string, unknown>;
  [key: string]: unknown; // app-specific fields permitted, read defensively
};

export type RemoteCaller = {
  peer<TActions extends Actions>(target: RemoteTarget): RemoteActions<TActions>;
};

export type RemoteTarget =
  | { clientId: number }
  | { deviceId: string; prefer?: 'unique' | 'any' }
  | { has: string };
```

Two overloads. The workspace overload structurally types the bits we need (`sync.rpc`, `sync.whenDisposed`, `awareness.getAll`); the adapter overload is for tests, custom transports, or fallback routing. Either way, the result is a `RemoteCaller` that produces typed proxies via `.peer<TActions>(target)`.

### Standard awareness convention

```ts
// packages/workspace/src/document/standard-awareness.ts

import { type } from 'arktype';

export const standardAwarenessDefs = {
  device: type({
    id: 'string',
    name: 'string',
    'platform?': "'chrome' | 'firefox' | 'tauri' | 'cli' | 'web'",
  }),
  offers: type('Record<string, unknown>'),
} as const;

export type StandardAwarenessDefs = typeof standardAwarenessDefs;
```

Apps that want to be cross-device-callable spread these into their awareness defs:

```ts
const awareness = attachAwareness(ydoc, {
  ...standardAwarenessDefs,
  client: type('"extension" | "desktop" | "cli"'),
});
```

The `Awareness` type constraint is **not** part of `createRemoteCaller`'s signature. We read `state.device?.id` and `state.offers?.[path]` defensively. Apps that don't publish standard keys produce `PeerOffline` when targeted by `{ deviceId }`. Validation happens at `attachAwareness` site (where the convention is or isn't followed), not at every consumer.

### `serializeActionManifest(actions)`

```ts
// packages/workspace/src/shared/actions.ts

export function serializeActionManifest(
  actions: Actions,
): Record<
  string,
  {
    type: 'query' | 'mutation';
    input?: TSchema;
    description?: string;
    title?: string;
  }
> {
  const out: Record<string, {...}> = {};
  for (const [action, path] of iterateActions(actions)) {
    out[path.join('.')] = {
      type: action.type,
      input: action.input,
      description: action.description,
      title: action.title,
    };
  }
  return out;
}
```

Apps call this once at session-applied to populate `awareness.setLocal({ device, offers, ... })`.

## Hidden invariants: explicit answers

The original spec waved past these. Each gets a definitive answer here.

### Ambiguous `deviceId`

Two tabs on the same browser publish the same `device.id`. The default behavior is **error**, not silent first-match:

```ts
remote.peer<TActions>({ deviceId: 'bob' });             // throws AmbiguousDeviceId if 2+ matches
remote.peer<TActions>({ deviceId: 'bob', prefer: 'any' }); // picks lowest clientId deterministically
```

`AmbiguousDeviceId` is a new `RpcError` variant. The error surfaces with the matching clientIds so the caller can choose:

```ts
type AmbiguousDeviceId = {
  name: 'AmbiguousDeviceId';
  deviceId: string;
  clientIds: number[];
  message: string;
};
```

Rationale: defaulting to "pick first" is non-deterministic and silently broken; defaulting to "error" makes ambiguity visible at the call site, and `prefer: 'any'` is the explicit opt-in.

### Mid-call peer churn

Resolution happens at call time, then `sync.rpc` awaits the response. If the peer disconnects mid-flight, `sync.rpc` surfaces `RpcError.Disconnected` (its existing behavior. It clears `pendingRequests` on socket close). The proxy passes that through unchanged.

We do **not** introduce a separate `PeerLeft` variant. `Disconnected` is the right name for "the wire died before I got a response," whether the cause was peer-side or transport-side.

### Disposed workspace

`createRemoteCaller(workspace)` reads `workspace.sync.whenDisposed`. After it resolves, all subsequent calls (and any in-flight calls if their resolutions are still pending) reject with `RpcError.WorkspaceDisposed`:

```ts
type WorkspaceDisposed = {
  name: 'WorkspaceDisposed';
  message: 'Workspace was disposed before the call could complete';
};
```

The low-level adapter form takes an explicit `whenDisposed?: Promise<unknown>` for tests and custom transports.

### Stale workspace reference

The proxy closes over `RemoteCaller`'s deps; `RemoteCaller` closes over the workspace. Long-lived proxies pin the workspace.

This is **acceptable**. Workspaces in this codebase are singletons at module scope; they're not GC'd in practice. If a future use case requires per-component workspaces with frequent churn, callers should `[Symbol.dispose]()` them and the proxy's calls will reject, no leak. Document, don't engineer for.

### Awareness without standard keys

If `state.device?.id` is undefined, `{ deviceId }` lookup never matches that peer; `PeerOffline` results. If `state.offers?.[path]` is undefined, `{ has }` lookup skips that peer. **No silent type errors at the call site.**

The caller can introspect state via `awareness.getAll()` directly to debug.

## Why kill `createRemoteActions`

The runtime-tree-walking factory takes `actions` as both shape source AND runtime tree, but doesn't actually invoke through the local actions. It produces a parallel proxy. After this spec, that's structurally identical to `createRemoteProxy<TypeOf<typeof actions>>(send)`, with one fewer dependency (no runtime tree).

`createRemoteActions(actions, send)` is dead weight. **Delete it.** Migrate its existing tests to `createRemoteProxy<typeof exampleActions>(send)`: same behavior, simpler signature.

## Concrete call-site comparison

### Before (today, working but unergonomic)

```ts
const peers = workspace.awareness.getAll();
let targetClientId: number | null = null;
for (const [clientId, state] of peers) {
  if (state.deviceId === 'bob-nanoid') {
    targetClientId = clientId;
    break;
  }
}
if (targetClientId === null) {
  toast.error('Bob is offline');
  return;
}

const result = await workspace.sync.rpc(
  targetClientId,
  'tabs.close',
  { tabIds: [123] },
);
// result: Result<unknown, RpcError>

if (result.error) {
  toast.error(extractErrorMessage(result.error));
  return;
}
const { closedCount } = result.data as { closedCount: number };
```

### After

```ts
import type { TabManagerActions } from '@epicenter/tab-manager';

const remote = createRemoteCaller(workspace);   // once, near workspace construction
const bob = remote.peer<TabManagerActions>({ deviceId: 'bob-nanoid' });

const result = await bob.tabs.close({ tabIds: [123] }, { timeout: 30_000 });
// result: Result<{ closedCount }, BrowserApiFailed | RpcError>

if (result.error) {
  toast.error(extractErrorMessage(result.error));
  return;
}
const { closedCount } = result.data;
```

### Local action call site for comparison (post-passthrough)

```ts
const result = await workspace.actions.tabs.close({ tabIds: [123] });
// result: Result<{ closedCount }, BrowserApiFailed>
// Same shape as remote, modulo RpcError union widening.
```

The local-vs-remote delta is exactly: error union widens by `RpcError`. The data type is unchanged. `RemoteActions<A>` makes that delta explicit and type-checked.

## TDD test plan

Tests written first, capturing desired ergonomics before implementation lands.

### Layer 1: `createRemoteProxy<TActions>(send)`: unit tests

```ts
// packages/workspace/src/rpc/remote-proxy.test.ts

describe('createRemoteProxy', () => {
  describe('routing', () => {
    test('routes single-segment path to send with empty input');
    test('routes nested path "tabs.close" to send with input');
    test('routes deeply nested path "a.b.c.d" correctly');
  });

  describe('return shape normalization', () => {
    test('Ok-wraps raw return value from send');
    test('passes through Result return from send unchanged');
    test('catches throws from send and returns Err(ActionFailed)');
    test('preserves Err.error.cause when send throws');
  });

  describe('options threading', () => {
    test('threads timeout option as third arg to send');
    test('threads AbortSignal option as third arg to send');
    test('omits options arg if caller does not pass one');
  });

  describe('type safety', () => {
    test('TypeScript: leaf has handler-derived input/output types');
    test('TypeScript: error union includes RpcError');
    test('TypeScript: nested paths preserve input/output types per leaf');
  });

  describe('proxy semantics', () => {
    test('property access returns a callable for any path');
    test('does not throw on unknown paths (server responds with ActionNotFound)');
    test('does not require runtime actions tree');
  });
});
```

### Layer 2: `createRemoteCaller`: unit tests with adapter overload

```ts
// packages/workspace/src/rpc/remote-caller.test.ts

describe('createRemoteCaller (adapter overload)', () => {
  describe('peer resolution', () => {
    test('{ clientId } maps directly without scanning peers');
    test('{ deviceId } resolves via state.device.id match');
    test('{ deviceId } returns Err(AmbiguousDeviceId) when multiple peers match');
    test('{ deviceId, prefer: "any" } picks lowest clientId on multiple matches');
    test('{ deviceId } returns Err(PeerOffline) when no peer publishes that id');
    test('{ has } returns first peer offering the action path');
    test('{ has } returns Err(PeerOffline) when no peer offers the path');
    test('peers without "device" key are skipped silently for { deviceId }');
    test('peers without "offers" key are skipped silently for { has }');
  });

  describe('disposal', () => {
    test('calls before whenDisposed resolve normally');
    test('calls after whenDisposed return Err(WorkspaceDisposed)');
    test('in-flight call resolves with whatever rpc returns even if dispose follows');
  });

  describe('options forwarding', () => {
    test('forwards timeout to deps.rpc');
    test('forwards AbortSignal to deps.rpc');
    test('omits options to deps.rpc if caller did not pass any');
  });

  describe('error propagation', () => {
    test('passes Err from deps.rpc through unchanged (no double-wrapping)');
    test('peer resolution errors precede rpc invocation');
  });
});

describe('createRemoteCaller (workspace overload)', () => {
  test('reads sync.rpc and awareness.getAll structurally');
  test('reads sync.whenDisposed for disposal hookup');
  test('does not require workspace to be of any specific type');
  test('accepts a structurally-compatible workspace from any app');
});
```

### Layer 3: integration: `createRemoteCaller` over `FakeWebSocket`

```ts
// packages/workspace/src/rpc/remote-caller.integration.test.ts

describe('createRemoteCaller integration', () => {
  test('Alice calls Bob via deviceId; Bob dispatches; Alice gets typed Result');
  test('Bob disconnects mid-call; Alice gets Err(RpcError.Disconnected)');
  test('Bob is not in the room; Alice gets Err(PeerOffline) before any wire send');
  test('Two Bob tabs in the room; Alice with default { deviceId } gets AmbiguousDeviceId');
  test('Two Bob tabs; { deviceId, prefer: "any" } picks lowest clientId, completes');
  test('Alice times out after 50ms; sync.rpc cancels via timeout option');
  test('Alice aborts via AbortSignal; sync.rpc surfaces appropriate error');
  test('Workspace disposes mid-flight; pending call resolves Err(WorkspaceDisposed)');
});
```

### Layer 4: `serializeActionManifest`

```ts
// packages/workspace/src/shared/actions.test.ts (new section)

describe('serializeActionManifest', () => {
  test('flattens nested actions into dotted paths');
  test('preserves input schema, description, title');
  test('preserves type discriminant: query vs mutation');
  test('skips non-action values in the tree');
  test('produces JSON-serializable output (no functions, no symbols)');
});
```

### Test infrastructure

- Reuse `FakeWebSocket` from `attach-sync.test.ts` for layer 3.
- Mock awareness via a simple `Map<number, PeerState>` adapter for layers 2 and 4.
- Type tests via `expectType<...>()` or assignability assertions for layer 1's "TypeScript:" cases.

### TDD ordering

Tests land first as `.skip` or expected-to-fail; implementation files import nothing yet. Then in order:

1. `serializeActionManifest` (smallest, isolated)
2. `createRemoteProxy` (no I/O dependencies)
3. `createRemoteCaller` adapter overload (resolution + disposal logic)
4. `createRemoteCaller` workspace overload (thin adapter)
5. Integration via FakeWebSocket
6. Migration of existing `remote-actions.test.ts` tests onto `createRemoteProxy` (then delete `createRemoteActions`)

Each test file runs green before moving to the next.

## Implementation phases

### Phase R1: Type-system additions in workspace package

- `RpcError.AmbiguousDeviceId` and `RpcError.WorkspaceDisposed` variants in `@epicenter/sync`.
- `RemoteSendOptions`, `RemoteSend`, `RemoteCallerDeps`, `PeerState`, `RemoteTarget`, `RemoteCaller` types.

### Phase R2: `serializeActionManifest`

- Add to `packages/workspace/src/shared/actions.ts` next to `iterateActions`.
- Tests per Layer 4.

### Phase R3: `standardAwarenessDefs`

- Add `packages/workspace/src/document/standard-awareness.ts`.
- Export from workspace barrel.

### Phase R4: `createRemoteProxy`

- Add `packages/workspace/src/rpc/remote-proxy.ts`.
- Tests per Layer 1.

### Phase R5: `createRemoteCaller`

- Add `packages/workspace/src/rpc/remote-caller.ts`.
- Tests per Layer 2.

### Phase R6: Integration tests

- Add `packages/workspace/src/rpc/remote-caller.integration.test.ts` per Layer 3.
- Reuse `FakeWebSocket`.

### Phase R7: Delete `createRemoteActions`

- Remove `packages/workspace/src/rpc/remote-actions.ts`.
- Migrate `packages/workspace/src/rpc/remote-actions.test.ts` → use `createRemoteProxy<typeof exampleActions>` instead.
- Remove from workspace barrel.

### Phase R8: App adoption

- Tab-manager: spread `standardAwarenessDefs` into `tabManagerAwarenessDefs`; publish `device` and `offers` in `setLocal`; export `TabManagerActions` type from public entry.
- One real demonstration call site in tab-manager: likely a "send tab to my desktop" command.

### Phase R9: Optional CLI migration

- CLI `epicenter run --peer deviceId=X` already works via direct `sync.rpc`. Migrate to `createRemoteCaller` internally for typed-error benefits and to dogfood the adapter overload.

## What this enables

1. **Typed cross-device dispatch.** UI on Alice calls Bob's actions as easily as local actions, with full type safety on inputs and outputs.
2. **AI agents calling remote tools.** TanStack AI tools wrap actions via `actionsToAiTools`. The same wrapping over `caller.peer<TActions>(target)` produces a tool that runs on a remote peer transparently: same code path, swapped delivery.
3. **CLI cross-device dispatch.** `epicenter run desktop-1.tabs.close` resolves `desktop-1` against awareness via `createRemoteCaller`'s adapter form.
4. **Discovery UI.** `awareness.getAll()` gives every peer; render `device.name` + render `offers` paths via TypeBox schema; let the user click to invoke any offered action on any peer.
5. **Custom routing.** `createRemoteProxy(mySend)` is the escape hatch for auth wrapping, audit log, retry semantics, HTTP fallback when WebSocket is dead, mock for tests, and anything else not in the convenience layer.

## Open questions deferred to follow-up

- **Versioning** in `offers` records: `version: '1.2.0'` per action? Defer until version skew bites.
- **Authorization**: any peer in the room can call any offered action. The room is the auth boundary today. Per-action auth via `dispatch` callback wrapping (the spec's "auth gate, audit log, rate limit" use case).
- **Retry semantics**: caller's responsibility today. Don't bake into the primitive.
- **Batching across paths**: probably never. Most use cases are independent.
- **Peer-state subscriptions**: "tell me when Bob comes online." Read-side concern; lives in `awareness.observe()`, not the caller.

## Cross-references

- `specs/20260425T200000-actions-passthrough-adr.md`: the action-shape decision this design depends on.
- `specs/20260425T000000-device-actions-via-awareness.md`: original awareness publishing proposal. This doc supersedes its `invoke()` helper; reuses `serializeActionManifest` and the `device`/`offers` convention.
- `packages/cli/src/util/find-peer.ts`: existing peer-resolution logic; pattern is generalized into `resolvePeer` inside `createRemoteCaller`.
