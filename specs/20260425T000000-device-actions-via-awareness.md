# Device-scoped action discovery and invocation via awareness

**Date**: 2026-04-25
**Status**: shipped (awareness publishing convention). Call-side API superseded by `specs/20260425T210000-remote-action-dispatch.md`; awareness-publishing piece is what landed.
**Author**: AI-assisted, pairing with Braden
**Builds on**: `specs/20260424T180000-drop-document-factory-attach-everything.md` (the post-factory architecture)

> **Path note (2026-05-22)**: The `epicenterPaths.deviceIdentity()` reference below is stale. The `epicenterPaths` symbol was removed; per-device state belongs under `env-paths('epicenter').data`. See `specs/20260522T203209-top-level-epicenter-path-cleanup.md`.

---

## One-sentence thesis

> Each device publishes its action set into awareness as JSON Schema. Any device can discover what every other online device offers, and invoke a specific peer's action via `sync.rpc`. No new attach primitive: just a state convention plus two helpers (`serializeActionManifest`, `invoke`).

---

## Use cases driving this

```
1. Run Claude Code on desktop from mobile
   ───────────────────────────────────────
   Mobile triggers; only desktop has the shell + CLI tool installed.

2. Transcribe audio on a Mac that has Whisper, from a phone
   ───────────────────────────────────────────────────────
   Phone records; Mac has the model.

3. "Open this URL in my desktop browser" from an iPad
   ─────────────────────────────────────────────────
   iPad sends a URL; desktop browser is the target.

4. Multi-Mac fallback: two laptops both have Claude Code
   ─────────────────────────────────────────────────────
   Either can serve. Caller picks any peer that offers it.

5. Read-only viewer device asks a writer device to mutate
   ─────────────────────────────────────────────────────
   Edge case; pure CRDT mutation works locally if the device has the action,
   but a constrained device might delegate.
```

What these have in common:
- **Action exists on some devices, not all.**
- **Caller doesn't statically know which device.** Discovery is needed at runtime.
- **The caller wants a synchronous response.** "Did the transcription succeed? Here's the text."

What they *don't* have in common with state mutations like `entries.create`:
- State mutations are **idempotent under CRDT**: every device can perform them, and the result merges. No need for cross-device dispatch.
- Cross-device side effects are **device-bound**: only the device with the capability can execute. Dispatching elsewhere is meaningless.

So: per-device side effects need a discovery + addressable-RPC layer. State mutations don't.

---

## Why "actions" stays one concept (not "actions + capabilities")

A "capability" here would be a typed callable with input schema, type tag, and an advertised location. **That's an action with awareness metadata.** Adding the term "capability" implies a separate primitive. There's only one: actions, with two new properties:

- *Locally implemented*: this device's `dispatch` callback handles incoming RPC for it.
- *Advertised in awareness*: this device announces it to peers.

In practice, every action a device implements is also advertised. So "advertised" is a derived consequence of "implemented and registered." One concept, one registry, one definition site (`defineQuery` / `defineMutation`).

What changes:
- Action sets vary per device. A mobile device's action registry might exclude `claude-code.run`; a desktop's includes it.
- Each device publishes its action set's *manifest* (schemas + types, not handlers) to awareness so peers can discover.
- A new helper `invoke(ctx, target, method, input)` finds the right peer (by clientId or by capability) and calls `sync.rpc`.

---

## Awareness state convention

Awareness already supports arbitrary JSON-shaped local state per device. We standardize the keys:

```ts
type DeviceAwarenessState = {
  device: {
    id: string;          // stable across reconnects (persisted locally)
    name: string;        // human-readable, may be user-editable
    platform?: string;   // 'darwin' | 'ios' | 'browser' | 'node' | etc.
    [key: string]: unknown;  // extension point: user adds whatever
  };
  // Schemas only: handlers stay local. JSON-serializable.
  offers: {
    [actionPath: string]: {
      type: 'query' | 'mutation';
      input?: TSchema;        // TypeBox JSON Schema (already JSON)
      description?: string;
      title?: string;
    };
  };
};
```

Each device sets this once at boot via `awareness.setLocalState({ device, offers })`. When sync connects, this state propagates to peers. When peers see a new device come online (or change state), they see its `offers`.

### Why TypeBox for schemas

TypeBox produces JSON Schema directly. The schema *is* the serializable form. arktype, Zod, and Standard Schema all need a `.toJsonSchema()` step. For awareness publishing, schema-as-data is the right shape, so TypeBox is the path of least resistance.

The framework accepts JSON Schema as the canonical format. Users may use any library that produces it; the convention here references TypeBox because it's the existing in-repo library and already used by Fuji's actions (`apps/fuji/src/lib/workspace.ts`).

### Device identity: generation, persistence, rename

`device.id` is generated once and persisted locally per device. `device.name` is user-editable. **No framework helper**: the pattern is short enough to inline; persistence is platform-specific anyway.

```ts
// At boot
const deviceId = localStorage.getItem('fuji:device-id') ?? crypto.randomUUID();
localStorage.setItem('fuji:device-id', deviceId);
const deviceName = localStorage.getItem('fuji:device-name') ?? 'Fuji Web';

// Initial publish
awareness.setLocalState({
  device: { id: deviceId, name: deviceName, platform: navigator.platform },
  offers: serializeActionManifest(actions),
});

// Rename: exposed to settings UI
export function renameDevice(newName: string) {
  localStorage.setItem('fuji:device-name', newName);
  const state = awareness.getLocalState();
  awareness.setLocalState({
    ...state,
    device: { ...state.device, name: newName },
  });
}
```

In Node (CLI, scripts), swap `localStorage` for a small file (e.g. at `epicenterPaths.deviceIdentity()`). Same shape, different storage.

**Constraint**: device ids must not contain dots. `crypto.randomUUID()` and nanoid never produce dots, so this is free. The constraint is needed so the dot-prefix CLI form (`desktop-1.action.path`) is unambiguous.

If three apps each ship near-identical 6-line device-identity helpers, *then* extract into the framework. Until then, inline.

---

## Helpers

### `serializeActionManifest(actions): DeviceAwarenessState['offers']`

Walks the action tree, extracts schema/type/description metadata for each branded action, returns a flat record. About 10 lines.

```ts
import { iterateActions } from '@epicenter/workspace';
import type { Actions } from '@epicenter/workspace';

export function serializeActionManifest(
  actions: Actions,
): DeviceAwarenessState['offers'] {
  const out: DeviceAwarenessState['offers'] = {};
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

**Why this exists**: keeping the user's action tree (nested, ergonomic for definition) and the awareness manifest (flat, JSON-serializable) as two views of the same data. The framework computes one from the other.

### `invoke(ctx, target, method, input): Promise<Result<unknown, RpcError>>`

Resolves the target peer (by clientId or by "any peer that offers this method"), then calls `sync.rpc`.

```ts
import { Result, Ok, Err } from 'wellcrafted/result';
import type { SyncAttachment, Awareness } from '@epicenter/workspace';

export type Target =
  | { peerId: number }
  | { has: string };           // any peer offering this action

export type InvokeError =
  | { name: 'NoOffer'; message: string }
  | { name: 'PeerOffline'; message: string }
  | RpcError;

export async function invoke<O = unknown>(
  ctx: { sync: SyncAttachment; awareness: Awareness },
  target: Target,
  method: string,
  input: unknown,
): Promise<Result<O, InvokeError>> {
  let peerId: number;

  if ('peerId' in target) {
    peerId = target.peerId;
  } else {
    const peers = ctx.awareness.getStates();
    const found = [...peers].find(
      ([id, state]) =>
        id !== ctx.awareness.clientID
        && method in ((state as DeviceAwarenessState).offers ?? {}),
    );
    if (!found) {
      return Err({ name: 'NoOffer', message: `No peer offers ${method}` });
    }
    peerId = found[0];
  }

  return ctx.sync.rpc(peerId, method, input);
}
```

**Why a function, not an attach**: `invoke` has no state of its own. It's pure dispatch over `sync` and `awareness`. Wrapping it in an attach adds ceremony (a setup line, a returned object) without storing anything. Function form keeps the model honest.

**Result type**: returns `Result<O, InvokeError>` per the wellcrafted pattern. Caller pattern-matches on `error` first, then uses `data`. Aligns with how the codebase already handles RPC errors (`packages/cli/src/util/emit-peer-errors.ts`).

---

## Architecture: three primitives, two helpers

```
                            ┌──────────────────┐
                            │      ydoc        │
                            └────────┬─────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            │                        │                        │
   ┌────────────────┐       ┌────────────────┐       ┌────────────────┐
   │ attachAwareness│       │   attachSync   │       │ attachTables / │
   │                │       │                │       │ attachKv / etc │
   │ - presence     │       │ - WebSocket    │       │ - typed views  │
   │ - state shape  │       │ - CRDT updates │       │                │
   │ - .setLocalState       │ - awareness    │       └────────────────┘
   │ - .getStates() │       │   transport    │
   └───────┬────────┘       │ - sync.rpc     │
           │                │ - dispatch     │
           │                └───────┬────────┘
           │                        │
           └────────┬───────────────┘
                    │
        ┌───────────┼───────────────┐
        │           │               │
        ▼           ▼               ▼
  ┌───────────────────┐  ┌────────────────────┐
  │ serializeAction   │  │      invoke        │
  │ Manifest(actions) │  │ (sync, awareness,  │
  │                   │  │  target, method,   │
  │ feeds awareness   │  │  input)            │
  │ .setLocalState    │  │                    │
  │                   │  │ for outbound RPC   │
  └───────────────────┘  └────────────────────┘
```

Three attaches stay independent. Two helper *functions* wire them together at the user's call site. No new attach primitive.

---

## Bootstrap example: full SPA

```ts
// apps/fuji/src/lib/client.svelte.ts

// ── Identity (persisted locally) ───────────────────────────────────
const deviceId = localStorage.getItem('device-id') ?? crypto.randomUUID();
localStorage.setItem('device-id', deviceId);

// ── Pure structural attaches ───────────────────────────────────────
const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, fujiTables);
const kv = encryption.attachKv(ydoc, {});
const awareness = attachAwareness(ydoc, {});

// ── Storage ────────────────────────────────────────────────────────
const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

// ── Behavior ───────────────────────────────────────────────────────
const actions = createFujiActions(tables);

// ── Publish identity + offers to awareness ─────────────────────────
awareness.setLocalState({
  device: { id: deviceId, name: 'Fuji Web', platform: 'browser' },
  offers: serializeActionManifest(actions),
});

// ── Network ────────────────────────────────────────────────────────
const sync = attachSync(ydoc, {
  url: websocketUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
  waitFor: idb.whenLoaded,
  awareness: awareness.raw,
  getToken: () => auth.getToken(),         // ← presence implies token-required
  dispatch: (method, input) => dispatchAction(actions, method, input),
});

// ── Export ─────────────────────────────────────────────────────────
export const fuji = {
  ydoc, tables, kv, awareness, encryption, idb, sync, actions,
  invoke: (target, method, input) =>
    invoke({ sync, awareness }, target, method, input),
  whenReady: idb.whenLoaded,
  [Symbol.dispose]() { ydoc.destroy(); },
};
```

Use:

```ts
// In SPA component: local action call (no schema run, no network)
fuji.actions.entries.create({ title: 'hi' });

// Cross-device: find a peer that offers it, invoke remotely
const result = await fuji.invoke(
  { has: 'claude-code.run' },
  'claude-code.run',
  { prompt: 'refactor this file', cwd: '/Users/braden/code' },
);
if (result.error !== null) {
  toast.error(result.error.message);
  return;
}
console.log(result.data);
```

---

## Per-device action sets: concrete example

A desktop device's action registry includes `claude-code.run`; a mobile's doesn't. Both include `entries.create`.

```ts
// On desktop: actions includes Claude Code
const actions = {
  ...createFujiActions(tables),
  'claude-code': {
    run: defineMutation({
      input: Type.Object({ prompt: Type.String(), cwd: Type.String() }),
      handler: async ({ prompt, cwd }) => {
        const output = await spawn('claude', ['-p', prompt], { cwd });
        return Ok(output);
      },
    }),
  },
};

// On mobile: actions excludes Claude Code
const actions = createFujiActions(tables);
```

Both call `serializeActionManifest(actions)` and publish to awareness. Each device sees the other's manifest and knows which actions are offered where.

`fuji.invoke({ has: 'claude-code.run' }, ...)` from mobile finds the desktop peer and dispatches via RPC. From desktop, it finds itself first (it's a peer offering the action): but since `awareness.clientID === found[0]` is filtered out, it picks another peer or returns `NoOffer`. Local invocation should not go through `invoke`; the caller should call `actions.claude-code.run(input)` directly. **The invoke helper is for cross-device dispatch only.**

(If a "smart invoke": prefer local, fall back to remote: turns out useful, that can ship as a separate helper later. Not in scope for v1.)

---

## CLI surface implications

The CLI loads a config that exports a workspace (per the teardown spec). With this awareness-based discovery, the CLI gains two new commands:

```bash
# List all online devices and their offered actions
$ epicenter devices
desktop-1 (Braden's Mac, darwin):
  - entries.create     (mutation)
  - entries.delete     (mutation)
  - claude-code.run    (mutation)

mobile-1 (Braden's iPhone, ios):
  - entries.create     (mutation)
  - entries.delete     (mutation)

cli-12345 (this device):
  - entries.create     (mutation)
  - entries.delete     (mutation)

# Invoke a specific peer's action
$ epicenter run desktop-1.claude-code.run '{"prompt":"...","cwd":"/"}'
# CLI resolves "desktop-1" via awareness device.id, then sync.rpc
```

The existing `epicenter peers` command already lists peers (`packages/cli/src/commands/peers.ts`). It can be extended (or replaced by `epicenter devices`) to render the offered actions per peer.

**Path syntax: keep both forms, with clear roles**:

```bash
# Dot-prefix (primary): when you know the target device id
$ epicenter run desktop-1.claude-code.run '{"prompt":"..."}'

# --peer flag (existing): for field matching ("any darwin device")
$ epicenter run claude-code.run --peer platform=darwin '{...}'
$ epicenter run claude-code.run --peer 'device.name=*Mac*' '{...}'
```

Resolution rules:
- First segment matches a `device.id` from awareness state → device-prefixed dispatch via `sync.rpc`.
- Otherwise → local dispatch (`dispatchAction(actions, path, input)`), or `--peer`-targeted dispatch if the flag is set.
- Action name happens to match a known device id (extremely rare given UUID device ids) → error, "ambiguous; use --peer to disambiguate."

Constraint: device ids must not contain dots. `crypto.randomUUID()` and nanoid don't produce dots, so this is free.

(Detailed CLI changes are out of scope for this spec, that's a separate update to the CLI scripting-first redesign spec.)

---

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| New attach primitive | **No**: function helpers only (`serializeActionManifest`, `invoke`) | The pattern is composition over `awareness.setLocalState` + `sync.rpc`. No state to manage in a new attach. Inline-first principle: ship the helpers; promote to a primitive only if the pattern duplicates painfully. |
| New "capability" concept | **No**: actions stay one concept | A capability is just an action that's advertised. Adding a separate term doubles the vocabulary without doubling the substance. |
| Schema serialization library | **TypeBox** for canonical form | TypeBox produces JSON Schema directly: schema *is* data. arktype/Zod/etc. work via `.toJsonSchema()` if users prefer those upstream. Framework's wire format is JSON Schema. |
| Awareness state shape | Standardized keys (`device`, `offers`) | Without a convention, every app would invent its own; tooling (CLI `devices`, agent introspection) couldn't be cross-app. Standardizing the keys lets one set of tools work against any workspace. |
| Per-device device id | **Persisted locally** (localStorage / file path) | Stable across reconnects. y-protocols' clientID is session-local (re-randomized per session), so the user-meaningful device identity must live elsewhere. |
| `invoke` target shapes | `{ peerId: number }` *or* `{ has: string }` | Direct addressing for known peers; capability-based addressing for "any peer that can do this." Two needs, one helper. |
| Local-vs-remote dispatch | Caller chooses. `invoke` is remote-only. | Local invocation goes through `actions.X.create(...)` directly: typed, fast, no network. `invoke` is the cross-device escape hatch. Smart "prefer local, fall back" is a future-additive helper if needed. |
| Response shape | wellcrafted `Result<T, InvokeError>` | Matches the codebase's existing pattern. Network errors, missing-peer errors, remote-thrown errors all surface as `Err` variants. |

---

## What this does NOT change

- `attachSync` and `attachAwareness` keep their current decomposition. Sync owns the WebSocket and RPC; awareness owns presence state. Sync transports awareness updates as before.
- The action registry shape from the teardown spec stays the same: branded callables in a nested tree.
- `dispatchAction(actions, method, input)` stays the local dispatcher. `dispatch` callback on `attachSync` keeps using it for incoming RPC.
- No new attach primitive. No new framework concept beyond the awareness state convention.

---

## What we deliberately considered and rejected

| Considered | Rejected because |
|---|---|
| Ship `attachCapabilities(awareness, sync, { device, serve })` as a new attach | All it would do is wrap `awareness.setLocalState` + `dispatch` setup in one call. The same wiring is 5 lines inline. Don't extract until it duplicates. |
| Bake capability publishing into `attachAwareness` (it gets a `serve` config) | Conflates awareness's job (presence) with action wiring (cross-cutting). `attachAwareness` should know about state, not handlers. |
| Split `attachSync` into `attachWebSocket` + `attachCRDTSync` + `attachRpcServer` + `attachRpcClient` | Maximum atomicity, but every consumer wants all four. Five setup lines for the common case. The `dispatch` and `getToken` parameters of `attachSync` are already the seam: config-option granularity, not attach granularity. |
| Make state mutations go through `invoke` too (unified addressing) | Wasteful network round-trips for operations every device can do locally. State mutations are CRDT-local; invoke is for true side effects. Keep the paths separate. |
| Auto-publish offers from inside `attachSync.dispatch` (sync writes to awareness on construction) | Sync would need to know about awareness's state shape and what's "an action." Better to have the user call `awareness.setLocalState({ offers: serializeActionManifest(actions) })` explicitly: visible in the bootstrap, no magic. |
| Use arktype-style validators (functions, not data) in awareness | Functions don't serialize. Schema-as-data is the load-bearing requirement; TypeBox gives it natively. |
| Name the concept "capability" | Adds vocabulary. Actions already do this job; we're just adding awareness publishing. |

---

## Implementation plan

### Phase 1: Helpers and conventions

- [ ] **1.1** Add `DeviceAwarenessState` type to `@epicenter/workspace` exports. Just the type; users construct values.
- [ ] **1.2** Implement `serializeActionManifest(actions)` (~10 lines). Export from `@epicenter/workspace`.
- [ ] **1.3** Implement `invoke(ctx, target, method, input)` (~30 lines including peer resolution). Export from `@epicenter/workspace`.
- [ ] **1.4** Update `packages/workspace/README.md` and the `workspace-api` skill to document the awareness state convention and helpers.

### Phase 2: Update bootstrap examples

- [ ] **2.1** Update `apps/fuji/src/lib/client.svelte.ts` to publish `device` + `offers` via `awareness.setLocalState`. Expose a typed `fuji.invoke(target, method, input)` on the export.
- [ ] **2.2** Update each playground config (`playground/tab-manager-e2e/epicenter.config.ts`, `playground/opensidian-e2e/epicenter.config.ts`) similarly.
- [ ] **2.3** Verify cross-device discovery: open Fuji on two devices (or two browser tabs), confirm `awareness.getStates()` shows both with their `offers`.

### Phase 3: CLI surface (separate spec coordination)

- [ ] **3.1** `epicenter peers` already exists. Extend it (or add `epicenter devices`) to render `offers` per peer.
- [ ] **3.2** `epicenter run <device>.<action>` resolves the device by `device.id` from awareness, calls `sync.rpc`. Coordinate with `cli-scripting-first-redesign` spec.
- [ ] **3.3** Decide on path syntax: `desktop-1.claude-code.run` (device-prefixed) vs the existing `--peer device.id=desktop-1 claude-code.run`. Likely keep both.

### Phase 4: Real cross-device use case (separate spec/PR)

- [ ] **4.1** Pick the first real consumer (Claude Code remote, or Whisper-on-Mac, or open-tab-in-browser).
- [ ] **4.2** Define the action(s) on the appropriate device's bootstrap. Include in `serializeActionManifest`.
- [ ] **4.3** Build the UI / CLI surface that calls `fuji.invoke(...)` against it.
- [ ] **4.4** When the second consumer lands, evaluate whether the duplication justifies extracting `attachCapabilities`. Don't extract sooner.

---

## Edge cases

### Device goes offline mid-invoke
`sync.rpc` will time out per its existing semantics. `invoke` returns `Err({ name: 'PeerOffline' or 'Timeout', ... })`. Caller handles via Result.

### Two devices offer the same action
`{ has: 'claude-code.run' }` resolves to the *first* peer iterated: implementation detail, no ordering guarantee. If the caller wants a specific one, they pass `{ peerId }` directly. If load-balancing or fallback is needed later, that's a wrapper helper, not framework concern.

### Schema in awareness is invalid / corrupted
The receiving device validates with `Value.Cast(schema, input)` (TypeBox) inside `dispatch`. Validation failure surfaces as an `RpcError` returned to the caller. The awareness publisher is the source of truth; if it published garbage, that's a deploy bug.

### Awareness state size grows large
A device with 100 actions × 1KB schemas = 100KB awareness state. Awareness is broadcast on every change. Realistically Fuji has ~5 actions, schemas under 500 bytes. Watch for this in Whispering / tab-manager if their action sets balloon. If it becomes a problem, the schemas can move to a Y.Map and awareness only carries the action *names*. But defer until measured.

### Offline → online transitions
On reconnect, awareness re-announces local state. Other peers see the device come back online. No special handling.

### CLI invokes its own action
The CLI is itself a peer. If the user runs `epicenter run cli-self.entries.create`, `invoke` finds the local clientID. But the helper filters that out (per the implementation above) and returns `NoOffer`. The CLI dispatching its own actions should go through `dispatchAction(entry.workspace.actions, path, input)` directly, not through `invoke`.

---

## Open questions

1. **Should `device.id` be a UUID, a user-typed name, or both?**
   - UUID for stability + a `name` field for display reads cleanly.
   - **Recommendation**: persist a UUID as `id`; let users edit `name` in settings.

2. **Awareness includes ephemeral state (cursor position, selected entry): does mixing it with `device`/`offers` cause issues?**
   - `device` and `offers` are static-after-boot. Cursor/selection update frequently.
   - Awareness reduces all keys into one state object on update. No issue with mixing, but bandwidth-conscious code might want to namespace.
   - **Recommendation**: keep them as top-level keys for now. Watch for traffic if it becomes painful.

3. **Should `invoke` expose timeout/retry options?**
   - Today `sync.rpc` accepts `{ timeout: ms }`.
   - **Recommendation**: pass-through the existing options. Don't invent new ones.

4. **Per-action authorization (e.g., only signed-in admin can run claude-code.run)?**
   - Out of scope for v1. The receiving device's `dispatch` callback can wrap actions with auth checks; that's app-level, not framework.

5. **`invoke` returns `Result`: how does this interact with actions whose handlers also return `Result`?**
   - **Resolved by the teardown spec's "always async + always Result" decision**: every action returns `Promise<Result<T, E>>` from the caller's perspective. Handlers may return raw values or `Result`s; the framework normalizes via `isResult(returnedValue) ? value : Ok(value)`.
   - Local callers always pattern-match `result.error`. Remote callers see the same shape; their error union widens by `RpcError | InvokeError`. No transport-aware type machinery needed at call sites.
   - The `RemoteReturn` conditional type (`packages/workspace/src/shared/actions.ts:515-528`) is removed; remote callers just see `Promise<Result<T, E | RpcError | InvokeError>>`.

---

## Success criteria

- [ ] `serializeActionManifest(actions)` round-trips: serialize on device A, JSON-serialize the awareness state, deserialize on device B, validate input against the recovered schema. End-to-end works.
- [ ] `invoke({ has: 'X' }, ...)` finds a peer offering X and returns the result. With no peer offering, returns `Err({ name: 'NoOffer' })`.
- [ ] Two-device test: one device defines `claude-code.run`, the other doesn't. The second device successfully discovers and invokes.
- [ ] `awareness.getStates()` on each device shows the other's `device` and `offers` correctly.
- [ ] No new attach primitive added to `@epicenter/workspace`.
- [ ] `bun test` passes; `bun run build` passes.

---

## References

### Builds on

- `specs/20260424T180000-drop-document-factory-attach-everything.md`: post-factory architecture, action shape, attach decomposition.

### Coordinates with

- `specs/20260421T155436-cli-scripting-first-redesign.md`: CLI dispatch surface (the dot-prefixed `<device>.<action>` form is a follow-up edit there).
- `specs/20260423T174126-cli-remote-peer-rpc.md`: existing `--peer` semantics; this spec aligns with them and adds a typed-discovery layer.

### Conversation that produced this spec

The reasoning that led here:

1. The teardown spec collapsed `Document` / `DocumentHandle` / `DocumentFactory` and most of the action-walking machinery.
2. With the cleanup done, the next question became "what's the action system *for*?": and a real use case (run Claude Code remotely from mobile) crystallized the per-device-side-effect category.
3. Considered (and rejected) introducing a "capability" concept as a separate primitive: actions already do the job, just need awareness publishing.
4. The load-bearing insight: TypeBox produces JSON Schema natively, so action schemas can live directly in awareness state.
5. Considered (and rejected) shipping `attachCapabilities` as a new attach. The pattern is just `awareness.setLocalState({ offers })` + `invoke()`: five lines of inline composition. Helper functions, no new primitive.
6. Decomposition question: should `attachSync` be split into WebSocket / CRDT / RPC primitives? Concluded no: the parameters (`dispatch`, `getToken`, `awareness`) already provide the seams; no current consumer needs the split. Defer until a real swap appears.
