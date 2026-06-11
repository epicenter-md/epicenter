# Document Sync and Identity Collapse

**Date**: 2026-05-13
**Status**: Draft (v2, hard break)
**Author**: AI-assisted (Claude + Braden design session)
**Branch**: TBD

## Overview

Collapse `@epicenter/workspace` to a single document primitive (`openCollaboration`), and put the identity trust boundary at the wire envelope: server stamps `subject` on an outer frame, client-claimed `replica` lives inside the Yjs awareness payload, and consumers read both via the peers surface. Hard break: no transitional shims, no deprecation re-exports.

## Motivation

### Current State

Two parallel document primitives wrap one supervisor:

```ts
// packages/workspace/src/document/open-collaboration.ts
openCollaboration(ydoc, { identity, actions, url, ... }): Collaboration

// packages/workspace/src/document/attach-yjs-sync.ts
attachYjsSync(ydoc, { url, ... }): YjsSyncAttachment   // hides 2 RPC methods
```

`attachYjsSync` composes nothing new. It forwards five lifecycle members and hides `sendActionRequest` / `sendRuntimeRequest`. The "two shapes" are one shape with a misleading second name.

The supervisor is bimodal via nullable config:

```ts
// packages/workspace/src/document/internal/sync-supervisor.ts:141-167
SyncSupervisorConfig = {
  awareness?: Awareness;                // null = byte-transport mode
  onActionRequest?: (...);               // null = ActionNotFound fallback
  onRuntimeRequest?: (...);              // null = ActionNotFound fallback
};
```

Null-checks scatter through every awareness handler and every RPC dispatch (`sync-supervisor.ts` lines 344, 373, 384, 388, 398, 408, 562).

Identity is a flat client-claimed blob:

```ts
// packages/workspace/src/document/peer-identity.ts:25-29
PeerIdentity = type({
  id: 'string',           // (user, device) conflated
  name: 'string',         // display, stale snapshot, lives in awareness
  platform: '"web" | "tauri" | "chrome-extension" | "node"',
});
```

The server treats awareness frames as opaque bytes. Clients claim their own identity, even though the server already authoritatively knows the connected user from the OAuth bearer.

Apps thread a `peer: PeerIdentity` through workspace constructors. Content docs use `attachYjsSync`, no identity at all.

### Problems

1. **Trust boundary is wrong.** Client claims its own identity. Server has the authoritative knowledge but doesn't use it. Same field can be impersonated by any client.
2. **Identity field conflates three lifetimes.** Subject (forever), replica (per install), display (changes mid-session) all in one blob, all republished together. Future cursors or status will collide.
3. **Two document primitives, one implementation.** `attachYjsSync` adds no behavior, no surface. Wrapper is symptom; dual API is disease.
4. **Supervisor bimodal by null-check.** Reading the file requires holding "is this configured?" in mind at every awareness handler.
5. **Display name is a stale snapshot.** Rename never propagates because `name` is captured at workspace construction.

### Desired State

```ts
// Schema (awareness payload): purely client-claimed
peerAwarenessSchema = {
  replica: type({ id: 'string', platform: '"web"|"tauri"|"chrome-extension"|"node"' }),
  actionPaths: type('string[]'),
};

// Wire envelope (new frame kind): server-stamped
{
  kind: 'awareness-attested',
  subject: string,             // server-derived from auth session
  payload: <opaque y-protocols awareness bytes>
}

// Consumer surface: joins envelope + payload by clientID
type Peer = {
  clientID: number;             // Yjs, per session
  subject: string;              // from envelope, server-trusted
  replica: { id, platform };    // from payload, client-claimed
  actionPaths: readonly string[];
};

// One document primitive; one workspace input
openCollaboration(ydoc, { url, replica, actions: {} });
openFujiBrowser({ replica, encryptionKeys, openWebSocket });
```

The server is the identity authority. The client publishes only what only the client knows. Display data lives outside this refactor.

## Research Findings

### Two-lens identity brainstorm

Two parallel brainstorm passes (structural decomposition + authority/trust) converged on the same tiered shape: subject (server-trusted, forever) + replica (client-claimed, per install) + display (lookup, mid-session mutable).

| Lens | Top pick | Convergence |
| --- | --- | --- |
| Structural (lifetime decomposition) | Orthogonal facets by lifetime | Subject / Replica / Presence as independent keys |
| Authority/trust | Tiered with trust boundary | Subject server-stamped, replica client-claimed, display looked up |

**Key finding**: lifetime decomposition and authority decomposition produce the same shape. The Yjs awareness schema is field-keyed and validated per-key, which makes the split structurally cheap.

**Implication**: the right shape is unambiguous. The remaining design space is *where* server-stamped subject lives (inside the awareness payload or on an outer envelope) and *how* it gets stamped.

### Envelope vs payload-rewrite

Investigation: how does the server stamp `subject` while preserving Yjs payload opacity?

| Mechanism | Server parses Yjs payload | Wire format change | Trust boundary visible at type level |
| --- | --- | --- | --- |
| Outer envelope | No | New frame kind | Yes (envelope vs payload) |
| Payload rewrite | Yes (must parse + re-encode awareness) | No (existing AWARENESS frame) | No (one field in one schema) |

**Key finding**: envelope is strictly cleaner. Server stays oblivious to y-protocols; the trust boundary is a wire-frame property, not a field convention.

**Implication**: envelope wins on every architectural axis. Cost is a new `MESSAGE_TYPE` in `@epicenter/sync`. Verify whether existing types can carry a stamped subject as a wrapper or whether a new kind is needed.

### Document primitive duality

Investigation: what does `attachYjsSync` add vs `openCollaboration`?

| Primitive | Supervisor config | Returns | Composes new surface |
| --- | --- | --- | --- |
| `openCollaboration` | awareness + RPC handlers | `Collaboration` | Yes: peers, identity, actions, `[Symbol.dispose]` |
| `attachYjsSync` | nothing extra | `YjsSyncAttachment` | No: forwards 5 lifecycle members |

**Key finding**: `attachYjsSync` is 14 lines of pure type narrowing. The wrapper exists only to hide RPC methods.

**Implication**: deleting `attachYjsSync` removes a file and a type but no behavior. Content docs become callers of `openCollaboration` with `actions: {}`.

### Cache pattern

Investigation: does `createDisposableCache` earn its keep?

**Key finding**: six concrete UI patterns break without it (multi-component observers on same body, fast back-nav, optimistic write upload past dispose, split views, reactive queries that read body data, HMR survival).

**Implication**: cache stays unchanged. What changes is what goes inside the build closure: `openCollaboration` instead of `attachYjsSync`.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Awareness payload contents | 2 coherence | Purely client-claimed: `replica` + `actionPaths` | Schema represents claims; trust-attested data lives on the envelope, not in the payload |
| Server-stamp location | 2 coherence | Outer envelope frame, server-attested | Yjs payload stays opaque; trust boundary visible at the wire frame |
| `subject` shape | 3 taste | `subject: string` (flat, not nested) | YAGNI: nest when a second field exists, not before |
| `replica` shape | 2 coherence | `replica: { id, platform }` | `id` is install-stable, `platform` is install-property; same cohesion |
| Drop `name` from identity | 2 coherence | Display data lives in a separate lookup (deferred to its own spec) | Display is mid-session mutable; identity is stable; conflating them breaks rename UX |
| Delete `attachYjsSync` | 2 coherence | Content docs use `openCollaboration` with `actions: {}` | Wrapper composes nothing; one primitive collapses two surfaces |
| `actions` default `{}` | 2 coherence | Optional with default | Content docs and consume-only peers don't need to pass an empty object |
| Supervisor nullable handlers become required | 2 coherence | `awareness`, `onActionRequest`, `onRuntimeRequest` required | Follows from killing `attachYjsSync`; deletes scattered null-checks |
| `actionPaths` stays top-level (not nested under `replica`) | 2 coherence | Top-level key | Consumed independently by peers surface; nesting adds an irrelevant dependency |
| `presence` key in this spec | 2 coherence | Not added | Schema is per-key validated; adding a field later is one line, not a migration |
| Workspace input contract | 2 coherence | `replica: { id, platform }`; subject comes from auth session | Client supplies only what only the client knows |
| Hard break (no transitional shims) | 3 taste | No deprecated re-exports; v1 types delete with v1 code | Pre-1.0; churn of transitional aliases costs more than rip-and-replace |
| `replica.id` generation strategy | 3 taste | Workspace package exports a small helper `createReplicaId({ storage })`; apps call it | One implementation, all apps use it; storage primitive passed as config |
| Server stamping wire format | Deferred | See Open Questions | Two viable sub-shapes within "envelope"; requires server reviewer |
| Anonymous link-share content docs | Deferred | Not in scope | Future case; subject-optional + per-link identity is a separate refactor |
| Display name lookup endpoint | Deferred | Not in scope | Lands in a separate spec when avatars/colors/rename UX become real |

## Architecture

### Wire layers, before and after

```
BEFORE
──────
Client publishes:                          Server relays:
y-protocols AWARENESS frame                opaque bytes (no parse, no stamp)
└─ { identity: { id, name, platform },
     actionPaths: [...] }


AFTER
─────
Client publishes:                          Server attests on ingress:
y-protocols AWARENESS frame (payload)      wraps in new envelope frame
└─ { replica: { id, platform },            ├─ subject: <auth-derived>
     actionPaths: [...] }                  └─ payload: <unchanged bytes>
                                           relays the envelope to peers

Peers receive:                             Consumer surface joins:
envelope { subject, payload }              { clientID, subject,
                                             replica, actionPaths }
```

### Trust boundary, type-level

```
┌────────────────────────────────────────────────────────────────┐
│ Awareness payload  (peerAwarenessSchema)   CLIENT-CLAIMED ONLY │
│  ├─ replica:    { id, platform }                                │
│  └─ actionPaths: string[]                                       │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ Wire envelope frame                         SERVER-ATTESTED    │
│  ├─ subject: string         (from auth session)                 │
│  └─ payload: <opaque y-protocols awareness bytes>               │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ Peer (consumer surface)         JOINED at the supervisor       │
│  ├─ clientID:    number     (Yjs, per-session)                  │
│  ├─ subject:     string     (from envelope, server-trusted)     │
│  ├─ replica:     { id, platform } (from payload)                │
│  └─ actionPaths: readonly string[]                              │
└────────────────────────────────────────────────────────────────┘
```

### Document primitive collapse

```
BEFORE                              AFTER
──────                              ─────
openCollaboration ────┐             openCollaboration
                      ├─► supervisor   (one entry point, full surface;
attachYjsSync ────────┘    (bimodal:    actions defaults to {})
                            null         │
                            handlers)    ▼
                                       createSyncSupervisor
                                       (internal; all config required)
```

### Workspace constructor

```
openFujiBrowser({ replica, encryptionKeys, openWebSocket })
     │
     ├── rootYdoc → openCollaboration({
     │        url: /workspaces/<rootGuid>,
     │        replica,                     ◄── passed by reference
     │        actions: rootActions,
     │   })
     │
     └── entryContentDocs = createDisposableCache((entryId) => {
              const childYdoc = new Y.Doc({ guid: entryContentDocGuid(...) })
              attachIndexedDb(childYdoc, ...)
              attachOwnedBroadcastChannel(childYdoc, ...)
              return openCollaboration(childYdoc, {
                  url: /documents/<childGuid>,
                  replica,                  ◄── same reference
                  // actions omitted; defaults to {}
              })
         })
```

## Implementation Plan

Build, Prove, Remove waves. Each wave is one commit. Deletion waves only run after verification.

### Wave 1: New awareness schema + helper (Build)

- [x] **1.1** Rewrite `packages/workspace/src/document/peer-identity.ts`. Replace `PeerIdentity` with `Replica`. New `peerAwarenessSchema = { replica, actionPaths }`. Export `Replica` and `Subject` types (`Subject = string`). _(landed earlier; peer-identity.ts also keeps legacy `PeerIdentity` alive until Wave 6 deletes it)_
- [x] **1.2** Add `createReplicaId({ storage })` helper in `packages/workspace/src/document/replica-id.ts`. Storage is the existing `SimpleStorage` shape (`{ getItem, setItem }`) so apps pass `localStorage` directly. First call generates a UUID and persists; subsequent calls return the persisted value. Persistence key is `epicenter.installation.id` so the legacy helper and the new helper share state during the transition.
- [x] **1.3** Unit tests: `Replica` schema accepts every supported platform and rejects unknown ones; `createReplicaId` / `createReplicaIdAsync` are idempotent and persist on first call.

### Wave 2: Server-side envelope (Build)

This wave is the one that needs the server-side reviewer per Open Question #1.

- [x] **2.1** Added `MESSAGE_TYPE.AWARENESS_ATTESTED = 100` to `packages/sync/src/protocol.ts` plus `encodeAwarenessAttested({ subject, update })` / `decodeAwarenessAttestedPayload(decoder)` helpers, exported from `@epicenter/sync`. Wire format: `[varuint 100][varString subject][varUint8Array opaque update]`. Old `AWARENESS` stays client to server only; server emits the attested form to peers.
- [x] **2.2** `RoomContext` gains a server-derived `subject` field; the DO parses it from `ctx.id.name` (format `user:{userId}:{type}:{name}`) once at construction in `apps/api/src/base-sync-room.ts`. `applyMessage`'s AWARENESS and QUERY_AWARENESS branches now emit `AWARENESS_ATTESTED` with `room.subject`; `computeInitialMessages` stamps the existing-states snapshot the same way. The opaque awareness bytes pass through unchanged.
- [x] **2.3** Added an explicit forgery-resistance test in `sync-handlers.test.ts`: a client encodes a `subject: 'attacker'` field inside the awareness payload, server's broadcast envelope still carries `room.subject`, not the forged value.
- [x] **2.4** `sync-supervisor.ts` decodes `AWARENESS_ATTESTED`, applies the opaque payload via the existing `handleRemoteAwarenessUpdate` path, and stamps a `peerMetadata: Map<clientID, { subject }>` using a synchronous closure during `applyAwarenessUpdate` so the awareness `update` event sees the envelope's subject. The map is removed when a clientID is dropped. Exposed on the `SyncSupervisor` surface as `readonly peerMetadata`. Wave 3 will wire it into the peers surface.

### Wave 3: `openCollaboration` config migration (Build)

- [x] **3.1** `OpenCollaborationConfig` drops `identity`, gains `replica: Replica`. `actions` is optional and defaults to `{}` inside `openCollaboration`. `Collaboration.replica` replaces `Collaboration.identity` on the return type.
- [x] **3.2** `openCollaboration` writes awareness with `{ replica, actionKeys }` (no client-side subject). The wire-level subject is stamped by the server on the envelope, not by the client.
- [x] **3.3** `Peer` shape now has `clientID`, `subject`, `replica`, `actionKeys`, plus `invoke` / `describe`. The legacy `id` and `identity` fields are gone. `peers.find(replicaId)` matches against `replica.id`.
- [x] **3.4** `createPeersSurface` takes the supervisor's `peerMetadata` as a parameter and joins it with the awareness payload at read time. The `peer.subject` field falls back to `""` when no envelope has arrived, so clients connected to a server that hasn't shipped attested envelopes degrade gracefully instead of throwing. Daemon `PeerSnapshot` was migrated to the new shape; CLI `peers` / `up` consumers read `subject` and `replica.id` (display names are deferred to a separate spec).

### Wave 4: Apps switch to `replica` (Build, Prove)

- [x] **4.1** `openFujiBrowser`, `openHoneycrispBrowser`, `openOpensidianBrowser`, `openTabManagerBrowser` drop `peer: PeerIdentity` and take `replica: Replica`. Daemon `openCollaboration` calls in `apps/{fuji,honeycrisp,opensidian,zhongwen}/blocks/daemon-route.ts` pass `replica: { id: '<app>-daemon', platform: 'node' }`. (whispering does not currently call `openCollaboration`; opensidian daemon also drops the redundant `actions: {}` since it now defaults.)
- [x] **4.2** Browser sessions construct replica id via `createReplicaId({ storage: localStorage })`. Tab-manager uses `createReplicaIdAsync({ storage: <chrome.storage adapter> })` and pairs the result with a `defaultName` ("Chrome on macOS" style) used purely to seed the device row, not the wire payload.
- [x] **4.3** Opensidian's `browser.ts` no longer references `attachYjsSync` (the dead-import situation the spec called out was already cleaned up); the daemon block uses `openCollaboration` with the default empty actions registry.
- [x] **4.4** Tab-manager's chat path reads `tabManager.collaboration.replica` instead of `.identity`; `registerDevice` takes a `defaultName` argument and reads `replica.id` for the device-row key. The CLI `peers` table shows `subject` + `replicaId` instead of `peerId` + `name`; the daemon block in `up.ts` formats join/leave lines with `replica.id` and the envelope subject.
- [x] **4.5** Workspace + api + sync test suites pass (645 + 59 + 49). All migrated apps typecheck clean (fuji, honeycrisp, opensidian, zhongwen, tab-manager). Smoke (server roundtrip) is deferred to a real run; the test forging `subject: 'attacker'` in the awareness payload (`sync-handlers.test.ts`) covers the protocol invariant unit-level.

### Wave 5: Verify clean break (Prove)

- [~] **5.1** `attachYjsSync` still has callers in fuji/honeycrisp browser bundles (per-row content docs) and in `apps/{honeycrisp,opensidian,zhongwen}/blocks/script.ts` (daemon-side sync scripts). Wave 6 folds the call-site migration into the deletion pass (each caller switches to `openCollaboration(ydoc, { ..., actions: {} })` first, then the file goes).
- [x] **5.2** `PeerIdentity` only survives inside `packages/workspace/src/document/peer-identity.ts` and its one re-export in `packages/workspace/src/index.ts`; no app references remain.
- [x] **5.3** `peer:` in workspace constructor arguments: zero remaining call sites (`openFujiBrowser`, `openHoneycrispBrowser`, `openOpensidianBrowser`, `openTabManagerBrowser` all take `replica:`).
- [ ] **5.4** Devtools wire check is a manual smoke deferred to the user. Protocol-level forgery resistance is covered by `sync-handlers.test.ts` ("broadcast envelope stamps room.subject, ignoring any subject the client encoded inside the payload").

### Wave 6: Delete old paths (Remove)

- [x] **6.1** Deleted `packages/workspace/src/document/attach-yjs-sync.ts` (and its smoke test). Every caller migrated to `openCollaboration(ydoc, { ..., actions: {} })`: fuji + honeycrisp browser content docs reuse the parent's `replica`, daemon scripts (`apps/{honeycrisp,opensidian,zhongwen}/blocks/script.ts`) pass a `'{app}-script'` node replica.
- [x] **6.2** `SyncSupervisorConfig` makes `awareness`, `onActionRequest`, `onRuntimeRequest` required. Removed every `?? null` indirection and the `if (!awareness)` / `if (!handler)` guards from `sync-supervisor.ts`. `dispatchIncomingRequest` no longer takes an `errorLabel`/fallback path.
- [x] **6.3** `websocketUrl` moved out of `sync-supervisor.ts` to `packages/workspace/src/document/transport.ts`; re-exported from the package root.
- [x] **6.4** Dropped the `SelfInvocationError` wire fallback in `open-collaboration.ts`. The peers surface still filters self by `replica.id`, so the only path that could have hit the fallback (stale clientID reference, test injection) now relies on caller hygiene. The `SelfInvocationError` type, its `RemoteCallError` membership, the CLI rendering branch, and the corresponding cli test were all removed.
- [x] **6.5** `PeerIdentity` / `PeerRuntime` are gone. The legacy section of `peer-identity.ts` is deleted; `packages/workspace/src/shared/device-id.ts` (and its test) are deleted; `replica-id.ts` carries the `SimpleStorage` / `AsyncStorage` definitions directly. `getOrCreateInstallationId{,Async}` are no longer exported.

### Post-implementation review fixes

Round of cleanup after `code-reviewer` audited the wave-6 result.

- **Subject is non-empty by construction.** Dropped the `subject ?? ''` fallback in `peer.ts`. A peer surface entry now requires a matching `peerMetadata.get(clientId)`: if the supervisor saw an awareness state without a matching `AWARENESS_ATTESTED` envelope (only possible on a wire-protocol violation), the peer is filtered from `peers.list()` / `peers.find()` rather than surfaced with an empty subject.
- **Bare-AWARENESS client decode path removed.** The "legacy server compatibility" branch in `sync-supervisor.ts` (and the orphan `handleRemoteAwarenessUpdate` helper) was the exact transitional shim the spec promised to delete. The client now only accepts `AWARENESS_ATTESTED`; servers that haven't shipped the envelope drop their peers out of the surface (intentional hard break).
- **`subjectFromDoName` fails loudly.** Replaced the silent empty-string fallback with a throw so misconfigured deployments (test rigs using `idFromString` / `newUniqueId`, or a future name-builder regression) blow up at boot instead of broadcasting empty-subject envelopes.
- **AWARENESS_ATTESTED rejection is now load-bearing tested.** Added an inbound test in `sync-handlers.test.ts` that constructs a client-side `AWARENESS_ATTESTED` frame with subject `"attacker"`, asserts the server returns no result and does not mutate awareness state. The previous test only covered payload-embedded forgery.
- **Closure pattern hardened.** `handleRemoteAwarenessAttested` now computes the affected clientID set by diffing `awareness.getStates()` keys before and after `applyAwarenessUpdate`, instead of relying on the `currentEnvelopeSubject` closure firing inside a synchronous y-protocols event. The supervisor's `awareness.on('update')` handler is reduced to its only remaining job: dropping `peerMetadata` entries on `removed`.

### Deferred follow-ups

These came up in review but are not blockers:

- **Content-doc presence is wasteful.** Every cached content doc opens its own `Awareness` + supervisor + peers surface even though no consumer reads them. A future `presence?: boolean = true` knob on `OpenCollaborationConfig` would let content docs skip the awareness channel entirely. Out of scope for this spec.
- **Self-RPC failure mode is silent round-trip.** With `SelfInvocationError` gone, a stale clientID pointing at self now routes through the server back to the same connection. Works but pays an RTT. The peers surface filters self by `replica.id` before this can happen in normal flows. Document or guard separately if it ever matters.
- **Stale doc references.** `packages/workspace/{README,SYNC_ARCHITECTURE}.md` and `packages/workspace/src/document/README.md` still mention `attachYjsSync`. A separate doc-cleanup pass will rewrite those sections to describe content-doc usage as `openCollaboration` with no actions.

## Edge Cases

### Multi-tab on same device, same workspace

1. User opens workspace in tab A and tab B.
2. Both tabs read the same `replica.id` from persistent storage.
3. Yjs assigns each tab a distinct `clientID`. Server stamps the same `subject` on both.
4. Peers see: two entries with same `subject`, same `replica`, distinct `clientID`. UI may collapse or show separately (taste).

### Logout / relogin mid-session

1. User signs out. Auth state changes.
2. The application-level auth observer disposes the workspace (`workspace[Symbol.dispose]()`).
3. WebSocket closes; supervisor's existing teardown path runs; all docs in the cache release.
4. New auth state, new workspace open, new collaboration session.

No special workspace-internal wiring needed: auth-state changes are an application concern, not a sync-layer concern.

### Server cannot attest (auth missing or expired)

1. Client connects with no or expired token.
2. Existing 4401 permanent-failure close code fires. No awareness frames are exchanged.
3. Covered by the existing path; no new logic needed.

## Open Questions

1. **Envelope wire format inside `@epicenter/sync`: new `MESSAGE_TYPE` or wrap existing?**
   - Options:
     - (a) **New `MESSAGE_TYPE.AWARENESS_ATTESTED`** carrying `{ subject: string, payload: <existing awareness bytes> }`. Old AWARENESS becomes client-to-server; new ATTESTED becomes server-to-peers.
     - (b) Wrap inline with a varint prefix on the existing AWARENESS frame, server-side only.
   - **Recommendation**: (a). Cleaner directionality (client never sends ATTESTED; server never sends bare AWARENESS to peers). Cost is one enum entry and one decoder branch in the supervisor.
   - **Needs**: server reviewer with `@epicenter/sync` parsers in their head before this wave lands.

2. **`presence` key in awareness schema, later: single optional key or namespaced extensions?**
   - When cursors/status/typing arrive, where do they live? One `presence` blob or app-defined per-doc fields?
   - **Recommendation**: Defer. Decide when the first real consumer lands. Schema is per-key validated so additions are cheap.

## Decisions Log

- **Keep `createDisposableCache` for content docs.** Constraint: load-bearing for multi-component observers on the same body, fast back-navigation, optimistic write upload past dispose, split views, reactive query reads, HMR survival. Six concrete UI patterns break without it.
  Revisit when: real UI evidence that refcount + grace doesn't pay for itself in any consumer.

- **Keep `platform` in `replica` (not server-stamped).** Constraint: server can read User-Agent at WS upgrade but UA parsing is messy and platform is per-install, not per-connection. Client-side runtime detection is reliable.
  Revisit when: server gains a reliable per-install platform signal (e.g., a registered-device API).

- **Keep `actionPaths` as a top-level awareness key (not nested under `replica`).** Constraint: peers surface consumes it independently from `replica`; nesting adds an irrelevant dependency.
  Revisit when: peers and replica resolution become tightly coupled in some feature.

- **No `presence` key in this spec.** Constraint: schema is field-keyed and validated per-key; adding a field later is a one-line schema change, not a wire migration. Adding it now is YAGNI.
  Revisit when: cursors, status, or typing-indicator features are scheduled.

- **No display name handling in this spec.** Constraint: display data is mid-session mutable (rename) and structurally different from identity; needs a lookup endpoint and a cache layer that don't belong in this refactor.
  Revisit when: rename UX or avatars become a product requirement.

## Success Criteria

- [ ] Zero references to `attachYjsSync` in `apps/` or `packages/`.
- [ ] Zero references to `PeerIdentity` in `apps/` or `packages/`.
- [ ] All workspace constructors accept `replica: Replica`; none accept `peer: PeerIdentity`.
- [ ] `SyncSupervisorConfig`: `awareness`, `onActionRequest`, `onRuntimeRequest` are required. Null-checks on these fields in `sync-supervisor.ts` are deleted.
- [ ] Awareness payload validates against `peerAwarenessSchema = { replica, actionPaths }`. No `subject` in the payload.
- [ ] Server stamps `subject` on the envelope from the auth session. A test confirms a client-forged subject in the payload is ignored.
- [ ] `openCollaboration` accepts `actions` as optional, defaults to `{}`. Content docs construct it without `actions`.
- [ ] `websocketUrl` is no longer exported from `sync-supervisor.ts`.
- [ ] `SelfInvocationError` wire fallback in `open-collaboration.ts` is removed.
- [ ] Workspace package typechecks. Full test suite passes.
- [ ] Manual smoke: open fuji, honeycrisp, zhongwen, whispering, opensidian. Peers list shows correct subject. Content docs lazy-load and sync. Two-tab scenario shows two clientIDs with one subject + replica.

## References

- `packages/workspace/src/document/peer-identity.ts` (the file being reshaped)
- `packages/workspace/src/document/open-collaboration.ts` (the one document primitive after collapse)
- `packages/workspace/src/document/attach-yjs-sync.ts` (deleted in Wave 6)
- `packages/workspace/src/document/internal/sync-supervisor.ts` (nullable fields removed in Wave 6)
- `packages/workspace/src/document/peer.ts` (peers surface; updated in Wave 3)
- `packages/workspace/src/cache/disposable-cache.ts` (unchanged; load-bearing)
- `packages/sync/` (server protocol; envelope frame added in Wave 2)
- `apps/fuji/src/routes/(signed-in)/fuji/browser.ts` (canonical workspace constructor; migrated Wave 4)
- `apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts`
- `apps/opensidian/src/lib/opensidian/browser.ts` (dead `attachYjsSync` import; fix in Wave 4)
- `apps/zhongwen/src/routes/(signed-in)/zhongwen/browser.ts`
- `apps/whispering/` (canonical workspace constructor; migrated Wave 4)
