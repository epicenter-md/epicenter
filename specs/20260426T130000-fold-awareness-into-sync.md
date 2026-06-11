# Fold awareness/presence into `attachSync`

**Date:** 2026-04-26
**Status:** Draft
**Author:** AI-assisted (Braden + Claude)
**Branch:** `post-pr-1705-cleanup`
**Supersedes:** [`20260426T120000-attach-peers-collapse.md`](./20260426T120000-attach-peers-collapse.md)

## One-sentence thesis

Awareness/presence isn't a separate concept from sync. It's the identity dimension of being synced. So fold the whole `attachAwareness` + `attachPeers` surface into `attachSync`, leaving `attachAwareness` as the escape hatch for custom presence schemas.

## Overview

The previous spec introduced `attachPeers` to hide the device-presence boilerplate. It worked, but it left the layering question on the table: why are awareness, presence, and sync three separate things when they share one WebSocket and one identity? This spec argues the split itself was the design mistake. Y-protocols already designed sync and awareness as siblings on one transport. We were artificially splitting them. By folding presence into `attachSync(doc, { device })`, app code drops from five orthogonal-but-wired calls to four, the `peer<T>` proxy takes a single arg, and the codebase stops carrying a vocabulary of three names (`awareness`, `peers`, `presence`) for one logical concept.

`attachAwareness` survives, but only as the escape hatch for genuinely custom presence schemas (cursors on content docs, etc.). The standard path is `attachSync`.

**Breaking change is fine.** No app has users yet.

## Motivation

### The deeper smell

The previous spec hid the device boilerplate behind `attachPeers`. The result was correct but felt off: `Peers` ended up wrapping `Awareness` with two pure-forwarder methods (`list`, `observe`) plus one genuine addition (`find`). The wrapper existed because of a *naming collision* (`peers.peers()` doubles), not because there was a real layering boundary.

When you mentally inline what an app actually does:

```ts
// 1. Yjs primitive (one connection's-worth of ephemeral state)
const yAwareness = new YAwareness(doc.ydoc);

// 2. Schema validation: pure typing
const typed = wrapWithSchema(yAwareness, standardAwarenessDefs);

// 3. Compute manifest: pure function
const offers = actionManifest(doc.actions);

// 4. Publish identity
typed.setLocal({ device: { ...device, offers } });

// 5. attach sync, REUSING the same yAwareness
const sync = attachSync(doc.ydoc, {
  awareness: yAwareness,    // same instance
  actions: doc.actions,     // for RPC dispatch
  url, getToken, waitFor,
});

// 6. peer<T> needs both
peer<TActions>({ awareness: typed, sync }, 'mac');
```

…three consumers (app's identity publication, sync's protocol routing, peer<T>'s clientId lookup) share *one* awareness instance. We've been treating them as siblings deserving a layer between them. But they're really one concept seen from three angles.

### What the user actually wants

Stripped of implementation vocabulary:

```
USER INTENT                               EXPRESSED AS
"Sync this Y.Doc to this URL with auth."  attachSync(url, getToken)
"I am this device with these actions."    (the device declaration)
"Persist locally for offline."             attachIndexedDb
"Share between tabs."                      attachBroadcastChannel
"Let me call other peers."                 peer<T>(target, 'mac')
```

Nothing in the user's mental model says "awareness" or "presence." Those are *implementation details* of how Yjs ships ephemeral state. The user thinks: identity, capabilities, connections.

### Desired state

```ts
const doc  = openFujiDoc();
const idb  = attachIndexedDb(doc.ydoc);
attachBroadcastChannel(doc.ydoc);
const sync = attachSync(doc, {
  url, getToken, device,
  waitFor: idb,
});

// One thing: sync: owns transport + identity + dispatch.
peer<TActions>(sync, 'macbook-pro');
```

Four lines. One concept. No `attachPeers`, no `attachPresence`, no `peers.awareness.raw`, no `{ peers, sync }` two-arg ceremony.

## Design

### `attachSync`: new shape

```ts
export type AttachSyncConfig = {
  url: string;
  getToken: () => Promise<string | null>;
  waitFor?: { whenLoaded: Promise<void> } | Promise<void>;
  /**
   * Optional. When provided, attachSync constructs a standard-schema
   * awareness internally, publishes `{ device: { ...device, offers } }`
   * synchronously, and exposes `peers()` / `find()` / `observe()` on the
   * returned attachment. When omitted, no presence is published and the
   * peer-lookup methods return empty maps / undefined.
   */
  device?: DeviceDescriptor;
};

export type AttachSyncDoc = {
  ydoc: Y.Doc;
  actions?: Actions;        // pulled for RPC dispatch routing
};

export function attachSync(
  doc: AttachSyncDoc,
  config: AttachSyncConfig,
): SyncAttachment;

export type SyncAttachment = {
  // Existing transport surface
  whenConnected: Promise<void>;
  whenDisposed: Promise<void>;
  goOffline(): void;
  reconnect(): void;
  rpc<TMap>(target: number, action: string, input?: ..., options?: ...): ...;

  // New presence surface (only meaningful when `device` was provided)
  peers(): Map<number, PeerAwarenessState>;
  find(deviceId: string): FoundPeer | undefined;
  observe(callback: () => void): () => void;

  // Escape hatches
  raw: { provider: WSProvider; awareness: YAwareness };
};
```

### `peer<T>()`: single-arg

```ts
// Today
peer<TActions>({ peers, sync }, 'mac');

// After
peer<TActions>(sync, 'mac');
```

The proxy duck-types `sync` for `find` + `rpc`. `PeerWorkspace` becomes inline, no named type, or we kill it entirely:

```ts
export function peer<TActions extends Actions>(
  sync: Pick<SyncAttachment, 'find' | 'observe' | 'rpc'>,
  deviceId: string,
): RemoteActions<TActions>;
```

Even the `Pick` is honest here. The proxy genuinely only needs three methods. (Earlier we used `Pick` performatively; here it's a real boundary because callers might want to mock `sync` for tests.)

Open question: even simpler: drop the `Pick` and take full `SyncAttachment`. Reason to keep `Pick`: explicit dependency footprint for test mocks. Reason to drop: less ceremony. Lean toward dropping.

### `attachAwareness`: escape hatch only

Stays exported. Schema-generic. Used when an app needs custom presence fields (cursors on content docs, typing indicators, "X is viewing settings", etc.). Apps stop using it for the *standard* device case: `attachSync` owns that.

Removed re-exports from package root:
- `attachPeers`, `Peers`, `PeerAwarenessState`, `FoundPeer`, `DocWithActions` (everything `attach-peers.ts` exposed)
- `actionManifest` becomes private to `attach-sync.ts`
- `standardAwarenessDefs` becomes private to `attach-sync.ts`

`PeerDevice`, `DeviceDescriptor`, `Platform` stay exported. They're the input shape and a public type.

### Layer diagram

```
USER MENTAL MODEL                      EXPRESSED IN CODE
─────────────────                      ──────────────────
the document substrate                 ydoc (Y.Doc)

local persistence                      attachIndexedDb / attachSqlite

intra-tab fan-out                      attachBroadcastChannel

I am online and connected              attachSync(doc, {
  - sync the CRDT                        url, getToken,
  - publish my identity                  device,           ← optional
  - dispatch RPC                         waitFor,
  - find peers                         })

a typed handle to one peer             peer<TActions>(sync, deviceId)

custom presence fields                 attachAwareness (escape hatch)
(cursors etc.)
```

## Migration plan

Five commits, executed in order. Each ships independently.

```
A. feat(workspace): attachSync owns standard presence
   ├── attach-sync.ts: accept doc bundle (not just ydoc); accept optional device
   ├── attach-sync.ts: when device, internally construct awareness + publish
   ├── attach-sync.ts: expose peers() / find() / observe() (always present;
   │                   return empty when no device)
   ├── attach-sync.ts: pull actions from doc.actions if not in config
   └── waitFor accepts attachment-or-promise

B. refactor(rpc): peer() takes sync directly
   ├── peer<T>(sync, deviceId): single arg
   ├── delete PeerWorkspace named type (inline)
   └── tests: mock sync directly (no separate peers mock)

C. refactor(apps): drop attachPeers; attachSync owns presence
   ├── 4 apps: remove attachPeers import; pass device into attachSync
   ├── apps return `sync` (no peers field on bundle)
   └── -1 line per app vs. current state

D. refactor(cli): consume sync.peers() / sync.find() / sync.observe()
   ├── LoadedWorkspace drops `peers?: Peers`
   ├── peer-wait.ts uses workspace.sync.peers() / observe()
   ├── list.ts / peers.ts use sync.peers()
   └── AwarenessState alias points at PeerAwarenessState (unchanged)

E. chore(workspace): delete attach-peers.ts and its exports
   ├── delete attach-peers.ts + attach-peers.test.ts
   ├── unexport actionManifest, standardAwarenessDefs from index
   └── tests live in attach-sync.test.ts (presence section added in A)
```

Commits A. B are additive (the new attachSync API can coexist with old attachPeers calls during transition). C. D migrate consumers. E removes the now-unused code.

## Test plan

- New tests in `attach-sync.test.ts`: presence section: device publishes synchronously, `peers()` excludes self, `find()` matches by deviceId, `observe()` fires on peer changes.
- Existing peer.test.ts continues to pass with the mocked sync (was mocked Peers; same shape).
- Existing CLI tests continue to pass (output unchanged; just the field path changes).
- Smoke test in tab-manager: extension boots, sync.peers() shows other connected devices.

## Design decisions

**Decision: Keep the function name `attachSync`.**

It still does sync. Presence is a face of being synced, not a separate concern. Renaming churns docs and muscle memory for marginal gain. The variable name at the call site is the user's call: name it `network` or `connection` if `sync.peers()` reads weird at a particular site.

The downside: `attachSync` undersells what it does. New users see it and assume "just CRDT sync." Mitigation is JSDoc, not renaming.

**Decision: `peers()` / `find()` / `observe()` always exist on `SyncAttachment`.**

Even when no device was provided. They return empty Map / undefined / no-op-unsubscribe. Type-wise this avoids conditional types or overload pyramids. Behaviorally this matches "no peers known to me right now", which is exactly what an empty list means.

Cost: silent failure if a user forgets to pass `device` and expects peers to show up. Mitigation: dev-mode warning log when `peers()` is called and no device is configured. Skip in v1; revisit if it bites.

**Decision: `device` is optional, not required.**

Content docs (`entryContentDocs`, `noteBodyDocs`, `fileContentDocs`) call `attachSync` without a device. They're sync'd but don't publish identity. Forcing them to pass a dummy device would be a worse API.

**Decision: Drop `attachPeers` entirely. Don't deprecate.**

No users. The function existed for one session. The migration is mechanical.

**Decision: `attachAwareness` stays exported.**

It's the escape hatch for genuinely custom presence schemas. Removing it would force apps wanting cursors-on-content-docs to wire y-protocols directly. Keep the primitive available; remove the *redundant* presets.

**Decision: `actionManifest` and `standardAwarenessDefs` become private.**

Folded inside `attach-sync.ts`. The CLI's only legitimate external use of `actionManifest` is computing a manifest from a *local* workspace's actions for `epicenter list`; `attach-sync.ts` can re-export `actionManifest` from a `shared/` path for that one consumer if needed.

**Decision: `peer<T>(sync, id)` over `peer<T>({ sync }, id)`.**

The proxy needs sync and only sync. Wrapping in an object adds nothing.

## Why not pure attach-as-side-effect

A tempting variant: each `attach*` mutates a shared workspace bundle:

```ts
const ws = openFujiDoc();
attachIndexedDb(ws);     // adds ws.idb
attachBroadcastChannel(ws);
attachSync(ws, { url, getToken, device });  // adds ws.sync
peer<T>(ws, 'mac');      // reads ws.sync internally
```

Why this is worse:
- Order is implicit but matters (sync must come after idb if waitFor is auto-wired).
- Mutation hides the dependency graph.
- Tests can't construct partial workspaces ergonomically.

Sticking with the explicit-return pattern: each attach returns its own handle, app code wires them. This spec changes only what attaches *what*, not the wiring style.

## Open questions

1. **Should `peer<T>` take a `Pick` or the full `SyncAttachment`?** Lean toward full type; the `Pick` is documentation pretending to be type safety (the same critique that retired the previous `PeerWorkspace` Pick).

2. **Where does the `actionManifest` re-export live for the CLI's local `list`?** Options: keep at package root (drop the un-export decision); expose under `@epicenter/workspace/cli` subpath; inline a lightweight version in the CLI itself. Defer until commit E lands and we see the import shape.

3. **Dev-mode warning when `peers()` is called without device?** Lean no; it's noise. Reconsider after a week of using the new API.
