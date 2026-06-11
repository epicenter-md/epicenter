# Collaboration runtime protocol plane

**Date**: 2026-05-13
**Status**: Implemented + post-implementation rename. Typecheck green (workspace, sync, api); affected unit tests (sync protocol, workspace peer / open-collaboration / actions) all pass.
**Author**: AI-assisted
**Branch**: refactor/standardize-symbol-dispose

## Final naming (after symmetry-rename pass)

Wire (`packages/sync`):

- `RPC_TYPE.ACTION_REQUEST` (value 0, renamed from `REQUEST`)
- `RPC_TYPE.RESPONSE` (value 1, unchanged)
- `RPC_TYPE.RUNTIME_REQUEST` (value 2, new)
- decoded discriminators: `'action-request'` / `'response'` / `'runtime-request'`
- runtime verb literal: `'describe-actions'`
- exported types: `RuntimeVerb`, `DecodedRpcMessage`
- exported encoders: `encodeRpcActionRequest` (renamed from `encodeRpcRequest`), `encodeRpcResponse`, `encodeRpcRuntimeRequest`

Supervisor (`packages/workspace/src/document/internal/sync-supervisor.ts`):

- inbound types: `IncomingActionRequest`, `IncomingRuntimeRequest`
- config callbacks: `onActionRequest`, `onRuntimeRequest` (both optional; absent means `RpcError.ActionNotFound`)
- send methods: `sendActionRequest`, `sendRuntimeRequest`
- shared internal helper: `sendTrackedRequest` (pending-bookkeeping + timeout + error normalization)
- internal dispatch helpers: `handleIncomingActionRequest`, `handleIncomingRuntimeRequest`

Peer surface (`packages/workspace/src/document/peer.ts`):

- `PeerWireHooks` exposes `sendActionRequest` and `sendRuntimeRequest`
- `peer.invoke` rides `sendActionRequest`; `peer.describe()` rides `sendRuntimeRequest('describe-actions')`
- `dispatch` helper takes a `send: () => Promise<...>` closure so both peer methods share the PeerLeft watchdog without sharing wire shape

Naming axis throughout: **Action / Runtime** matches the wire kinds end-to-end. No `Rpc`-prefixed identifier names a single plane.

## One-sentence thesis

App actions occupy the user action tree alone; collaboration runtime requests are handled by the runtime before action dispatch.

## Overview

Separate runtime protocol requests (currently `peer.describe()`) from app action requests at the wire layer, so user-authored actions and runtime-owned operations stop sharing a namespace. The peer-introspection capability is preserved by name. The reserved `system.*` action namespace, the `SystemActions` type, and the runtime `fullActions` synthesis go away.

## Motivation

### Current state

`openCollaboration` accepts user actions, then injects runtime actions into the same tree:

```ts
const systemActions: SystemActions = Object.freeze({
  describe: defineQuery({
    handler: () => describeActions(userActions),
  }),
});
const fullActions = Object.freeze({
  ...userActions,
  system: systemActions,
});
```

RPC dispatch resolves against the merged tree. `peer.describe()` is wired through the same action-path channel:

```ts
describe: (options) =>
  dispatch(clientId, state.identity.id, 'system.describe', undefined, options),
```

The type boundary defends the namespace:

```ts
actions: TActions & { system?: never };
```

### Problems

1. **Conflation of planes.** Protocol RPC and app RPC share one path space. The runtime has to defend a namespace because they share it.
2. **Defensive type constraint.** `TActions & { system?: never }` exists only because of the namespace collision.
3. **Inert leakage.** `describeActions(userActions)` calls correctly skip system actions, but every consumer of the action tree has to model the fact that some leaves are runtime-owned. The wire path for describe is the magic string `'system.describe'`.
4. **No room for future verbs.** Adding system-level capability (version, health, capability advertise) would crowd the same shared namespace.

### Desired state

The wire distinguishes the two request kinds. The supervisor dispatches them on separate planes. App authors see only their own actions. The collaboration runtime owns the protocol verb plane.

## Research findings

### y-protocols conventions (via DeepWiki, repo `yjs/y-protocols`)

> Two-level message type hierarchy: top-level `MESSAGE_TYPE` byte plus protocol-specific sub-type byte. Type IDs 2+ available for custom protocols. New independent protocols get a new top-level byte; variants within a protocol get a sub-type.

Epicenter already uses `MESSAGE_TYPE.RPC = 101` (a custom top-level type) with two sub-types: `RPC_TYPE.REQUEST = 0`, `RPC_TYPE.RESPONSE = 1`. Adding a third sub-type for runtime verbs is consistent with the y-protocols pattern because the new sub-type shares routing fabric and response envelope with `REQUEST`: it is a variant of the same protocol, not a new protocol.

### Alternatives considered

| Approach | Pro | Con |
| --- | --- | --- |
| Reserved character prefix in action keys (`$describe`) | Tiny diff; no wire change | Magic string. Still one path space. User loss: forbids a character. |
| Push manifest into awareness | No RPC needed | Manifest size bloats awareness on every state change. Awareness is for ephemeral lightweight state. |
| New top-level `MESSAGE_TYPE` byte | Maximal separation | Duplicates response envelope and pending-request bookkeeping. Heavyweight. |
| New `RPC_TYPE` sub-type within MESSAGE_TYPE.RPC | Shares response envelope and DO routing. Wire-level discriminator is structurally collision-proof. | New wire kind; DO must decode it. |
| Type-level `system?: never` only | Smallest diff | Keeps the namespace conflation; just defends it at compile time. Was the previous patch, explicitly rejected. |

### Decision

Add `RPC_TYPE.PROTOCOL_REQUEST = 2` carrying a closed-set verb string. Currently the only verb is `'describe-actions'`.

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Sub-type vs new MESSAGE_TYPE | 2 coherence | New RPC sub-type | Shares response envelope and DO routing path; conceptually still RPC. |
| Verb on wire vs sub-type per verb | 3 taste | One sub-type with `verb: ProtocolVerb` string | Adding future runtime verbs is a TS change, not a wire+DO change. Closed `ProtocolVerb` union keeps it honest. |
| Discriminator string for decoded type | 3 taste | `'protocol-request'` (existing `'request'` kept for app actions) | Less churn; symmetry by suffix. Rename `'request'` → `'action-request'` was considered but trades clarity for diff size. **Open question for the reviewer.** |
| Verb name | 3 taste | `'describe-actions'` (kebab) | Matches naming convention of the action manifest concept. Extensible to `'describe-identity'` etc. without overload. |
| Sub-type constant name | 3 taste | `RUNTIME_REQUEST` (chosen during review) | "Protocol" is overloaded with the y-websocket layer; "Runtime" matches the task vocabulary and pairs cleanly with `ACTION_REQUEST`. |
| Existing `RPC_TYPE.REQUEST` rename | 2 coherence | Renamed to `ACTION_REQUEST` | Symmetric naming axis (Action / Runtime). RPC is the category; both kinds are RPC. |
| Supervisor config shape | 2 coherence | Two callbacks: `onActionRequest` (app), `onRuntimeRequest` (runtime) | Symmetric with wire sub-types. Each callback gets exactly its plane. |
| Delete `SystemActions` type | 2 coherence | Delete | Only existed to type the injected runtime action. With injection gone, it has no consumer. |
| Delete `actions: TActions & { system?: never }` | 2 coherence | Delete reservation | Wire-level plane separation makes user-action `system` namespaces legal again. No collision exists. |
| Preserve `peer.describe()` | 1 evidence | Keep | User task explicitly requires the capability. |
| Cross-version wire compat | 3 taste | Not preserved (no claimed compat for now) | Old peer + new peer would fail to decode the new sub-type. Same epicenter version is assumed across deployments. |

## Architecture

### Wire (new sub-type added to existing RPC protocol)

```
MESSAGE_TYPE.RPC (101)
  RPC_TYPE.ACTION_REQUEST  (0)   app action: requestId, target, requester, action_path, json_input
  RPC_TYPE.RESPONSE        (1)   shared envelope: requestId, requester, json_Result<T, E>
  RPC_TYPE.RUNTIME_REQUEST (2)   runtime verb:    requestId, target, requester, verb_string
```

Both ACTION_REQUEST and RUNTIME_REQUEST share the same DO forward-by-clientId routing path. RESPONSE is unchanged.

### Receiver dispatch

```
                 Y.Doc
                   │
        ┌─────── supervisor ────────┐
        │                            │
   onActionRequest             onRuntimeRequest
   (app actions)               (runtime verbs)
        │                            │
        ▼                            ▼
   resolveActionPath           switch (verb)
        │                       case 'describe-actions':
   invokeActionForRpc                 describeActions(userActions)
```

App actions never enter the runtime callback. Runtime verbs never enter the action dispatcher. No string-prefix discrimination.

### Caller flow for peer.describe()

```
peer.describe()
  → peer hook sendRuntimeRequest(clientId, 'describe-actions')
  → supervisor.sendRuntimeRequest
  → wire: encodeRpcRuntimeRequest(...)
  → DO forwards by targetClientId
  → remote supervisor decodes RPC sub-type RUNTIME_REQUEST
  → remote onRuntimeRequest({ verb: 'describe-actions' })
  → describeActions(userActions)
  → wire: encodeRpcResponse(Ok(manifest))
  → DO forwards by requesterClientId
  → caller resolves Promise<Result<ActionManifest>>
```

## Implementation plan (waves landed)

All waves complete on branch `refactor/standardize-symbol-dispose`. Final names use the Action / Runtime axis after the post-implementation rename pass.

### Wave 1: wire (packages/sync)
- [x] `RPC_TYPE.ACTION_REQUEST` (renamed from `REQUEST`), `RPC_TYPE.RUNTIME_REQUEST` (new), `RuntimeVerb` type, `encodeRpcActionRequest` (renamed from `encodeRpcRequest`), `encodeRpcRuntimeRequest` (new), decode branches.
- [x] Export from `packages/sync/src/index.ts`.
- [x] Round-trip tests in `protocol.test.ts`.

### Wave 2: DO routing (apps/api)
- [x] `sync-handlers.ts`: forward `'action-request'` and `'runtime-request'` identically (shared `targetClientId` route and `onMissReply`).

### Wave 3: supervisor (packages/workspace)
- [x] Add `IncomingActionRequest`, `IncomingRuntimeRequest` types.
- [x] Decode `action-request` / `runtime-request` branches; dispatch to corresponding callback.
- [x] Add `sendActionRequest`, `sendRuntimeRequest` methods sharing a `sendTrackedRequest` helper for pending-bookkeeping and error normalization.

### Wave 4: open-collaboration
- [x] Remove `SystemActions` import and `fullActions` synthesis.
- [x] Pass `onActionRequest` resolving against `userActions` directly.
- [x] Pass `onRuntimeRequest` with a closed-set verb switch (exhaustiveness enforced by TypeScript on the `RuntimeVerb` union).
- [x] Drop `actions: TActions & { system?: never }`; the field is now `actions: TActions`.

### Wave 5: peer.ts
- [x] `PeerWireHooks` exposes `sendActionRequest` and `sendRuntimeRequest`.
- [x] `peer.describe()` rides `sendRuntimeRequest('describe-actions')`.
- [x] `dispatch` helper refactored to take a `send: () => Promise<...>` closure so both peer methods share the PeerLeft watchdog without sharing wire shape.

### Wave 6: actions.ts cleanup
- [x] `SystemActions` type deleted.
- [x] `system.describe` references scrubbed from JSDoc.

### Wave 7: tests + verify
- [x] `peer.test.ts`: `peer.describe` test routes through `sendRuntimeRequest` and asserts the action hook is not called.
- [x] `open-collaboration.test.ts`: `@ts-expect-error` guard test removed; new test asserts `actions.system` is legal at the type level.
- [x] `bun run typecheck` clean in `packages/sync`, `packages/workspace` (only pre-existing errors unrelated to this work), `apps/api`.
- [x] `bun test` green for sync protocol, workspace peer, open-collaboration, and actions tests.

### Wave 8: deletion sweep
- [x] grep confirms zero references to `SystemActions`, `system.describe`, `fullActions`, `encodeRpcRequest` (non-action), `onRpcRequest`, `sendRpcRequest`, `IncomingRpcRequest`, `PROTOCOL_REQUEST`, `ProtocolVerb`.

### Wave 9: post-implementation symmetry rename
- [x] Renamed `Rpc`-prefixed action-plane identifiers to `Action` (`encodeRpcActionRequest`, `IncomingActionRequest`, `onActionRequest`, `sendActionRequest`, `PeerWireHooks.sendActionRequest`).

## Edge cases

1. **Old client targets new server.** The DO decodes via `decodeRpcMessage`. An old DO with the new sub-type would hit `Unknown RPC sub-type: 2` and throw. The DO change ships with the wire change.
2. **New client targets old server.** Same: the old DO would not know the new sub-type. Deployment requires updating the DO first (apps/api) before clients.
3. **User authors `actions.system`.** Now legal. `walkActions` will include `system.<...>` paths. The action manifest from `describeActions(userActions)` will include them. Backward-compatible for users who previously avoided that key.

## Open questions

1. **Sub-type name: `PROTOCOL_REQUEST` vs `RUNTIME_REQUEST`?**
   - Recommendation: `RUNTIME_REQUEST`. "Protocol" is overloaded with the y-websocket layer. "Runtime" matches the user's task vocabulary ("runtime meta operations").
2. **Verb name: `'describe-actions'` vs `'describe'`?**
   - Recommendation: `'describe-actions'`. Explicit about what is being described, leaves room for `'describe-identity'` etc. without confusion.
3. **Discriminator string symmetry: rename existing `'request'` → `'action-request'`?**
   - Recommendation: Yes if doing a clean break. Touches three files (`sync-supervisor.ts`, `sync-handlers.ts`, `protocol.test.ts`). Skip if scope concern dominates.
4. **E2E coverage gap.** No integration test exercises peer → DO → peer for either REQUEST or PROTOCOL_REQUEST. The current confidence path is: unit tests for wire round-trip, unit tests for `peer.describe()` with a mocked send hook, type checks. Should we add a true end-to-end test that boots a local DO and runs a real peer pair through `peer.describe()` before declaring done?

## Success criteria

- [ ] `grep -r system.describe packages/workspace/src` returns zero matches.
- [ ] `grep -r SystemActions packages/workspace/src` returns zero matches.
- [ ] `actions: TActions` accepts a top-level `system` key at compile time.
- [ ] `peer.describe()` returns the same `ActionManifest` shape as before.
- [ ] `bun run typecheck` passes in `packages/workspace`, `packages/sync`, `apps/api`.
- [ ] `bun test` passes for `actions.test.ts`, `peer.test.ts`, `open-collaboration.test.ts`, `protocol.test.ts`.

## References

- `packages/sync/src/protocol.ts`: wire encode/decode
- `packages/sync/src/index.ts`: exports
- `packages/sync/src/protocol.test.ts`: round-trip tests
- `apps/api/src/sync-handlers.ts`: DO routing
- `packages/workspace/src/document/internal/sync-supervisor.ts`: receiver dispatch
- `packages/workspace/src/document/open-collaboration.ts`: runtime protocol handler wiring
- `packages/workspace/src/document/peer.ts`: `peer.describe()` call site
- `packages/workspace/src/shared/actions.ts`: `SystemActions` deletion
- `packages/workspace/src/document/peer.test.ts`: test rewrite needed
- `packages/workspace/src/document/open-collaboration.test.ts`: type-guard test removal
