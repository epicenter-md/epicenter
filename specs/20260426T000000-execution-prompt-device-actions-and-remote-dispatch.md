# Execution prompt: device actions + remote dispatch (PR-D + PR-E, collapsed)

**Status:** queued
**For an implementer with no prior conversation context.** Self-contained brief.

**Prerequisites:**
- PR #1705 (`drop-document-factory`) has merged to main.
- `actions-passthrough-adr` is already shipped (commits `2be551876` + `81cd627ee`).
- `auth-core-package` is already shipped (24 commits on the drop-document-factory branch).

**Branch:** create a fresh branch off main. Suggested name: `device-actions-and-remote-dispatch`.

**Read these specs first:**
- `specs/20260425T210000-remote-action-dispatch.md`: the design, especially the "Final design (post-collapse pass)" section at the top. The body below is historical v2 context; the section at top is the source of truth.
- `specs/20260425T000000-device-actions-via-awareness.md`: original PR-D/PR-E architecture. Awareness-publishing piece is still load-bearing; the call-side `invoke()` proposal is superseded by the spec above.

---

## What you're doing

Add two capabilities, one PR:

1. **PR-D side**: each device publishes its action manifest into Yjs awareness, alongside a per-installation deviceId.
2. **PR-E side**: any device can call any peer's actions type-safely via `peer<T>(sync, deviceId).path.to.action(input)`.

Plus an opportunistic collapse to `attachSync`'s API (`actions:` data instead of `dispatch:` callback), and a CLI cleanup that drops the now-unused fuzzy peer matching.

**This is one PR with eight commits.** Each commit independently typechecks and tests green. Total ~600 lines deleted, ~250 added (net negative).

---

## The eight commits

### Commit 1: `feat(workspace): SimpleStorage adapter + getOrCreateDeviceId helper`

Add the per-installation deviceId convention.

**New file:** `packages/workspace/src/shared/device-id.ts`

```ts
import { generateId } from './id.js';

/** Sync get/set storage adapter. localStorage, chrome.storage (post-hydration), tauri-plugin-store wrappers all conform. */
export type SimpleStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const KEY = 'epicenter.device.id';

/** Read or create a per-installation deviceId nanoid. Idempotent. */
export function getOrCreateDeviceId(storage: SimpleStorage): string {
  const existing = storage.getItem(KEY);
  if (existing) return existing;
  const fresh = generateId();
  storage.setItem(KEY, fresh);
  return fresh;
}
```

**Export from barrel:** `packages/workspace/src/index.ts`: add `getOrCreateDeviceId` and `type SimpleStorage`.

**Tests:** `packages/workspace/src/shared/device-id.test.ts`: read-existing returns same value; read-empty creates and persists; second call returns the persisted value.

No app consumers yet.

---

### Commit 2: `feat(workspace): standardAwarenessDefs + actionManifest helper`

Add the publishing-side primitives.

**New file:** `packages/workspace/src/document/standard-awareness-defs.ts`

```ts
import { type } from 'arktype';

export const Platform = type("'web' | 'tauri' | 'chrome-extension' | 'node'");

export const ActionManifestEntry = type({
  type: "'query' | 'mutation'",
  'input?': 'object',           // JSON Schema produced by Value.JSONSchema(action.input)
  'title?': 'string',
  'description?': 'string',
});

export const Device = type({
  id: 'string',
  name: 'string',
  platform: Platform,
  offers: { '[string]': ActionManifestEntry },
});

/** Spread into attachAwareness defs to get typed access to peer.device. */
export const standardAwarenessDefs = {
  device: Device.or('null'),
};
```

**New file:** `packages/workspace/src/shared/action-manifest.ts`

```ts
import { Value } from 'typebox/value';
import { type Actions, isAction } from './actions.js';

export type ActionManifest = Record<string, {
  type: 'query' | 'mutation';
  input?: object;     // JSON Schema
  title?: string;
  description?: string;
}>;

/** Walk an action tree, return a flat manifest keyed by dot-path. */
export function actionManifest(actions: Actions): ActionManifest {
  const out: ActionManifest = {};
  walk(actions, [], out);
  return out;
}

function walk(node: Actions, path: string[], out: ActionManifest): void {
  for (const [key, value] of Object.entries(node)) {
    const childPath = [...path, key];
    if (isAction(value)) {
      out[childPath.join('.')] = {
        type: value.type,
        input: value.input ? Value.JSONSchema(value.input) : undefined,
        title: value.title,
        description: value.description,
      };
    } else if (value != null && typeof value === 'object') {
      walk(value as Actions, childPath, out);
    }
  }
}
```

**Exports:** add `standardAwarenessDefs`, `actionManifest`, `type ActionManifest`, `Device`, `Platform` to the workspace barrel.

**Tests:** `action-manifest.test.ts`: covers nested trees, omits non-action nodes, JSON Schema is included when `input` is set, handles no-input actions.

No app consumers yet.

---

### Commit 3: `feat(workspace): peer<T>(): typed remote-action proxy`

The call side. Replace `packages/workspace/src/rpc/remote-actions.ts` with the new API.

**New file:** `packages/workspace/src/rpc/peer.ts`

```ts
import { RpcError } from '@epicenter/sync';
import { Ok, Err, isResult, type Result } from 'wellcrafted/result';
import type { Actions, RemoteActions } from '../shared/actions.js';
import type { Awareness } from '../document/attach-awareness.js';
import type { SyncAttachment } from '../document/attach-sync.js';

export type PeerCallOptions = { timeout?: number; signal?: AbortSignal };

/** Workspace shape we need: awareness for resolution, sync for transport. Duck-typed so app workspaces conform without ceremony. */
type PeerWorkspace = {
  awareness: Awareness<{ device: { decode: (raw: unknown) => { id: string } | null } }> & {
    raw: { getStates(): Map<number, Record<string, unknown>>; on(event: 'change', fn: () => void): void; off(event: 'change', fn: () => void): void };
  };
  sync: Pick<SyncAttachment, 'rpc' | 'whenDisposed'>;
};

/** Walk awareness for the first peer publishing this deviceId, in clientId-ascending order. */
export function resolvePeer(
  awareness: PeerWorkspace['awareness'],
  deviceId: string,
): Result<number, ReturnType<typeof RpcError.PeerNotFound>> {
  const states = awareness.raw.getStates();
  const clientIds = [...states.keys()].sort((a, b) => a - b);
  for (const clientId of clientIds) {
    const state = states.get(clientId);
    const device = (state as { device?: { id?: string } } | undefined)?.device;
    if (device?.id === deviceId) return Ok(clientId);
  }
  return Err(RpcError.PeerNotFound({ peer: deviceId }).error);
}

/**
 * Build a typed remote-action proxy. Each leaf is an async function returning
 * `Promise<Result<T, E | RpcError>>`. The proxy is stateless; each call resolves
 * the deviceId against awareness and dispatches via workspace.sync.rpc.
 */
export function peer<TActions extends Actions>(
  workspace: PeerWorkspace,
  deviceId: string,
): RemoteActions<TActions> {
  // Per-deviceId pending-call tracking for disconnect-aware short-circuit
  const pending = new Set<{ reject: (err: unknown) => void }>();
  const onAwarenessChange = () => {
    if (pending.size === 0) return;
    const stillThere = workspace.awareness.raw.getStates();
    const found = [...stillThere.values()].some(
      (s) => (s as { device?: { id?: string } }).device?.id === deviceId,
    );
    if (!found) {
      const err = RpcError.PeerLeft({ peer: deviceId }).error;
      for (const p of pending) p.reject(err);
      pending.clear();
    }
  };
  workspace.awareness.raw.on('change', onAwarenessChange);
  // No explicit dispose: the workspace's sync.whenDisposed will free the awareness instance, which drops the listener naturally.

  return buildProxy<TActions>([], async (path, input, options) => {
    const resolved = resolvePeer(workspace.awareness, deviceId);
    if (resolved.error) return resolved;
    const tracker = { reject: (_e: unknown) => {} };
    pending.add(tracker);
    try {
      return await new Promise<Result<unknown, RpcError>>((resolveCall, rejectCall) => {
        tracker.reject = (err) => resolveCall(Err(err as RpcError));
        workspace.sync
          .rpc(resolved.data, path, input, options)
          .then((res) => resolveCall(isResult(res) ? res : Ok(res)))
          .catch((cause) => resolveCall(Err(RpcError.ActionFailed({ peer: deviceId, action: path, cause }).error)));
      });
    } finally {
      pending.delete(tracker);
    }
  });
}

type Sender = (path: string, input: unknown, options?: PeerCallOptions) => Promise<Result<unknown, RpcError>>;

function buildProxy<T>(path: string[], send: Sender): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = function () {} as any;
  return new Proxy(target, {
    get(_t, prop: string) {
      if (typeof prop !== 'string') return undefined;
      return buildProxy([...path, prop], send);
    },
    apply(_t, _this, args: unknown[]) {
      const [input, options] = args as [unknown, PeerCallOptions | undefined];
      return send(path.join('.'), input, options);
    },
  });
}
```

**Delete:** `packages/workspace/src/rpc/remote-actions.ts`: folded into `peer.ts` (the `buildProxy` internal). Move the small set of `remote-actions.test.ts` cases that still apply (proxy shape, normalize behaviors) into `peer.test.ts`.

**Update barrel:** `packages/workspace/src/index.ts`
- **Remove** `createRemoteActions`, `RemoteSend` exports.
- **Add** `peer`, `resolvePeer`, `type PeerCallOptions`.

**Tests:** `peer.test.ts` covers:
- Proxy resolves dotted paths to action calls
- Peer-not-found returns `Err(PeerNotFound)` without dispatching
- Multiple peers with same deviceId → first match by clientId order
- Awareness `change` after peer disappears → in-flight call rejects with `PeerLeft`
- Raw return value gets `Ok`-wrapped; thrown handler gets `Err(ActionFailed)`; existing `Result` passes through

No app consumers yet.

---

### Commit 4: `refactor(workspace): attachSync takes actions: data, drops dispatch:`

Replace the `dispatch:` callback in `attachSync` config with `actions:` data.

**Edit:** `packages/workspace/src/document/attach-sync.ts`
- Remove `dispatch?: RpcDispatch` from `SyncAttachmentConfig`.
- Add `actions?: Actions` (optional: workspaces without actions still work; inbound RPC returns `RpcError.ActionNotFound`).
- Inside `handleRpcRequest`, replace `const dispatch = config.dispatch; const result = await dispatch(...)` with the inline equivalent: walk `config.actions` via `dispatchAction`, normalize via `invokeNormalized`.
- Remove `RpcDispatch` from public exports.

**Migrate all 6 apps:** `apps/{fuji,honeycrisp,opensidian,zhongwen,tab-manager}/src/lib/<name>/browser.ts` and `apps/dashboard/...`. For each:

```ts
// before
attachSync(ydoc, {
  url, getToken: () => auth.getToken(),
  dispatch: (action, input) => dispatchAction(doc.actions, action, input),
});
// after
attachSync(ydoc, {
  url, getToken: () => auth.getToken(),
  actions: doc.actions,
});
```

Drop the now-unused `dispatchAction` import from each app file.

**Verify:** `bun test packages/workspace`, `bun test packages/cli`, all app `bunx tsc --noEmit` clean.

---

### Commit 5: `feat(apps): publish device + offers from each app`

Wire publishing into each app.

**For each app** (`apps/{fuji,honeycrisp,opensidian,zhongwen,tab-manager}/src/lib/<name>/`):

1. Add a `device-id.ts` sibling that builds the platform-appropriate `SimpleStorage` and calls `getOrCreateDeviceId`. Examples:

   **Browser SPAs (fuji, honeycrisp, opensidian, zhongwen):**
   ```ts
   import { getOrCreateDeviceId } from '@epicenter/workspace';

   export const deviceId = getOrCreateDeviceId({
     getItem: (k) => localStorage.getItem(k),
     setItem: (k, v) => localStorage.setItem(k, v),
   });
   ```

   **Tab-manager (chrome.storage):** wrap chrome.storage with a `whenReady`-gated synchronous adapter (pattern matches the existing `createStorageState` in `apps/tab-manager/src/lib/state/storage-state.svelte.ts`). The deviceId resolves after `whenReady`.

2. In the app's `index.ts` (iso) or `browser.ts` (env-bound): spread `standardAwarenessDefs` into the `attachAwareness` call, and call `awareness.setLocal({ device: { ... } })` with the manifest:

   ```ts
   import { attachAwareness, standardAwarenessDefs, actionManifest } from '@epicenter/workspace';
   import { deviceId } from './device-id';

   const awareness = attachAwareness(ydoc, { ...standardAwarenessDefs });
   const actions = createFujiActions(tables);
   awareness.setLocal({
     device: {
       id: deviceId,
       name: 'Fuji',                    // app-specific; could be user-configurable later
       platform: 'web',
       offers: actionManifest(actions),
     },
   });
   ```

3. Choose `name` and `platform` per app. `platform` is one of `'web' | 'tauri' | 'chrome-extension' | 'node'`. Pick at compile time per app target.

**Verify:** open two apps in different tabs/windows, confirm via devtools that `awareness.peers()` shows the other side's device + offers.

---

### Commit 6: `refactor(cli): collapse find-peer to exact deviceId match`

Drop the fuzzy peer-matching DSL.

**Edit:** `packages/cli/src/util/find-peer.ts`
- Drop substring-of-lowercased fuzzy fallback (lines ~66-79 in the current file).
- Drop `case-ambiguous` error path.
- Replace with: `resolvePeer(awareness, deviceId)` from `@epicenter/workspace`.
- The function becomes a 5-line wrapper around the workspace export.

**Edit:** `packages/cli/src/commands/run.ts`
- The `--peer` flag parser: drop the `device.<field>=<value>` form. `--peer <deviceId>` only.
- Drop the dot-prefix `<deviceId>.<action>` resolution if it was implemented (per spec, it should not have been: verify).

**Edit:** `packages/cli/src/commands/peers.ts`
- Verify the `epicenter peers` table format puts `DEVICE ID` as the first or second column (so copy-paste discovery works). Tweak if buried.

**Tests:** update `find-peer.test.ts`: drop fuzzy cases, add first-match-wins cases.

**Verify:** `bun test packages/cli` green; manual `epicenter peers` followed by `epicenter run --peer <id> tabs.close --json '...'` against a running second instance.

---

### Commit 7: `test(workspace): publish/discover/call e2e`

End-to-end test using two in-process workspaces sharing a Yjs awareness instance.

**New file:** `packages/workspace/src/__tests__/peer-e2e.test.ts`

Coverage:
- Two workspaces with different deviceIds publish manifests; each can read the other's `awareness.peers().get(otherClientId)?.device.offers`.
- `peer<T>(wsA, wsB.deviceId).action(input)` dispatches, returns `Ok(handlerResult)`.
- Handler that throws → call resolves to `Err(ActionFailed)`.
- Handler that returns `Result` → unwrapped on the wire, re-wrapped client-side, error union widens to `RpcError`.
- Disconnecting wsB mid-call → in-flight call resolves to `Err(PeerLeft)`.
- Calling unknown deviceId → `Err(PeerNotFound)`, no wire send.
- Calling action that wsB doesn't offer → `Err(ActionNotFound)` from wsB's `attachSync` boundary.

---

### Commit 8: `docs(specs): mark device-actions and remote-action-dispatch shipped`

- `specs/20260425T210000-remote-action-dispatch.md`: change status to `shipped`. The "Final design" section at the top is already the source of truth.
- `specs/20260425T000000-device-actions-via-awareness.md`: change status to `shipped` (publishing convention is what landed; the `invoke()` shape was superseded and that's documented).
- `specs/20260425T180002-orchestration-tracker.md`: mark PR-D and PR-E rows as shipped; reference this branch.

---

## Verification before opening the PR

- [ ] `bun test`: all packages, all apps, green.
- [ ] `bunx tsc --noEmit` across all packages and apps clean.
- [ ] Manual: open Fuji in two browser tabs (same install → same deviceId); open Honeycrisp in a third tab. Confirm `awareness.peers()` shows three entries with two distinct deviceIds.
- [ ] Manual: from a CLI script, `peer<HoneycrispActions>(fujiWorkspace, honeycrispDeviceId).<some-action>({...})` succeeds.
- [ ] `epicenter peers` from inside the apps directory shows the running peers; `epicenter run --peer <id> <action> --json '...'` dispatches.
- [ ] Lighthouse / devtools: awareness payload per peer is under 5 KB for the largest app's manifest.

---

## Rollback notes

Each commit is independently revertible. Highest-risk commit is #4 (collapsing `dispatch:` → `actions:` on `attachSync`) because it touches every app. If type errors surface across apps that aren't mechanical, revert #4 alone: commits 1, 2, 3, 5, 6 are independently safe (1, 2, 3 add unused exports; 5 publishes nothing anyone reads yet; 6 cleanups behind unused features).

---

## Out of scope (do not add to this PR)

- **Per-action authorization gates**: the workspace room is the auth boundary in v1. Re-litigate when a real consumer asks.
- **Fan-out** (`peer.all<T>(...)`).
- **`{ clientId }` direct addressing**: defer until needed.
- **Per-action timeout in metadata**: caller passes `{ timeout }` per call.
- **Lazy schema fetch**: full schema in awareness for v1.
- **HTTP fallback transport / `createRemoteProxy(send)` public primitive**: the internal `buildProxy(send)` helper inside `peer.ts` can be promoted to public if a real consumer asks.
- **Auth-core unit tests**: separate PR (the auth-core spec's open follow-up).
