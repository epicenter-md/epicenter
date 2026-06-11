# system.describe + wire-trim manifest

**Status**: Superseded
**Date**: 2026-04-26
**Supersedes (partial)**: `specs/20260426T190000-cli-actions-unification.md` (the unified `ActionManifestEntry === ActionMeta` is preserved at the type level, but the wire shape narrows: `input` no longer travels in the manifest)

**Superseded By**: `20260426T230000-drop-manifest-from-awareness.md`

**Review 2026-05-01**: This halfway design should not be executed. The current
architecture removed action manifests from awareness entirely. `system.describe`
now takes no input and returns the full action manifest through
`createRemoteClient({ peerDirectory, rpc }).describe(peerId)`.

## Problem

Each peer publishes an action manifest into Yjs awareness so other peers can introspect "what can you do." The manifest is `Record<dotPath, ActionMeta>` where `ActionMeta = { type, input?, title?, description? }`. The `input` field is a TypeBox `TSchema`: JSON Schema. For a typical app with ~20 actions each carrying non-trivial input shapes, this lands around **10kB per manifest**.

Awareness broadcasts every peer's full state to every other peer on every refresh tick (~15s). Steady-state cost grows with N²·M. At today's scale (N≤5, M≈10kB) the absolute bandwidth is small, but the **cold-connect cost** (N·M) and the **wake-frequency × wall-time** profile on Cloudflare DO Hibernation make this a genuine smell waiting for the trip wire.

The smell distilled: we're broadcasting input schemas that **exactly one consumer reads**, and only when that consumer (the CLI `list --peer X some.path` detail view) is explicitly drilled into. 99% of peers never look at 99% of `input` payloads they receive.

## Decision

**Drop `input` from the wire manifest. Inject `system.describe(path)` as a runtime-provided RPC action that returns the full local `ActionMeta` (including `input`) for one path. CLI detail view fetches via RPC on demand.**

### Why this design

| Alternative | Why not |
|---|---|
| New top-level protocol type `MESSAGE_TYPE.META = 102` | Overengineering for one operation; ~100 LoC duplicates auth/routing/error infrastructure that RPC 101 already provides. Migrate later if introspection grows past ~3 ops. |
| `__describe__` reserved RPC action (dunder convention) | Python-flavored hack; reads as magic, not contract. |
| Delete `--describe` UX entirely | Throws away a useful introspection feature for a problem that doesn't yet bite. |
| Keep status quo + deflate manifest with CompressionStream | Shrinks bytes ~7x but every peer still pays decode cost on every read; doesn't fix the architectural smell that `input` is broadcast unicast-relevant data. |
| Y.Map in the doc | Per-installation runtime state is wrong shape for document content; no GC story for dead devices. |

`system.*` reserved namespace matches **25-year-old prior art** (XML-RPC's `system.listMethods`, JSON-RPC's `system.*`). It's a contract surface, not a magic name. The validator in the manifest walker enforces "user actions cannot define `system.*`" so the namespace is genuinely reserved, not just by convention.

### Wire-shape change

```
BEFORE                              AFTER
─────────────────────────────       ─────────────────────────────
ActionManifestEntry = {             ActionManifestEntry = {
  type: 'query'|'mutation'            type: 'query'|'mutation'
  input?: object   ← ~500B/entry      title?: string
  title?: string                      description?: string
  description?: string              }
}
```

Manifest size projection: ~10kB → ~1kB (≥10x reduction).

### Type-layer change

`ActionMeta` (TypeScript, in `actions.ts`) stays unchanged: local code still has full schema access via the in-memory action tree. The unification from `specs/20260426T190000-cli-actions-unification.md` is preserved structurally (one TypeScript type, one renderer). Only the **arktype wire schema** (`ActionManifestEntrySchema` in `standard-awareness-defs.ts`) drops `input?: object`. Wire-decoded entries simply have `input === undefined` at runtime.

### Dispatch-layer change

```
attach-sync.ts (around line 328)

BEFORE                              AFTER
─────────────────────────────       ─────────────────────────────
const actions = config.actions      const userActions = config.actions
  ?? docActions;                      ?? docActions;

                                    const systemActions = {
                                      describe: defineQuery({
                                        input: type({ path: 'string' }),
                                        handler: ({ path }) =>
                                          getLocalActionMeta(
                                            userActions ?? {}, path),
                                      }),
                                    };

                                    // Dispatch tree includes system.*;
                                    // manifest does NOT.
                                    const actions = {
                                      ...(userActions ?? {}),
                                      system: systemActions,
                                    };

…                                   …
offers: actionManifest(              offers: actionManifest(
  actions ?? {}),                      userActions ?? {}),
                                    // ← validator inside actionManifest
                                    //   throws if userActions has
                                    //   top-level "system" key.
```

### Validator

`action-manifest.ts walk()` throws on encountering top-level path segment `system` in user-provided actions. Error message: `"User actions cannot define the 'system.*' namespace. It's reserved for runtime-injected meta operations."` One unit test for the throw.

### CLI consumer change

`list.ts:357 printActionDetail` becomes async. When called with peer-sourced metadata (where `action.input` is now always `undefined`), fetches full `ActionMeta` via `peer.system.describe({ path })` and renders the resulting `input` schema. Local-mode rendering is unchanged (full `ActionMeta` already in memory).

## Out of scope (intentionally)

- `system.list`, `system.health`, `system.version`, or any other meta op: only `system.describe` ships now. Add later as needed without protocol changes.
- Manifest compression (`CompressionStream` deflate). The wire trim alone gets us 10x; compression on top would be ≤2x more for ~50 LoC of cache infrastructure. Revisit if M ever climbs back above 5kB.
- Splitting `device` into separate `presence` + `manifest` awareness keys. Awareness broadcasts full local state on every refresh: splitting is API hygiene only, **zero wire savings**. Defer until there's a separate optimization that benefits from the seam.
- `META` (102) protocol type. Mechanical refactor target if we ever have 3+ system ops.

## Files changed

| # | File | Change |
|---|---|---|
| 1 | `packages/workspace/src/shared/action-manifest.ts` | (a) Drop `if (value.input !== undefined) entry.input = value.input;` at line 31. (b) Add `system.*` validator in `walk()`: throw if top-level segment is `system`. |
| 2 | `packages/workspace/src/document/standard-awareness-defs.ts` | Drop `'input?': 'object'` from `ActionManifestEntrySchema` (line 39). Update JSDoc to note `input` is local-only. |
| 3 | `packages/workspace/src/document/attach-sync.ts` | Inject `system.describe` query into dispatch tree. Keep `offers: actionManifest(userActions ?? {})` referencing user actions only. |
| 4 | `packages/workspace/src/shared/actions.ts` | Update JSDoc on `ActionMeta` (line 94) to reflect that wire entries omit `input` (local `ActionMeta` keeps it). |
| 5 | `packages/workspace/src/shared/action-manifest.test.ts` | Rewrite the `input`-presence assertions (lines 48-50, 62) to: (a) assert `entry.input` is **never** present on manifest output. (b) Add a test that defining a user `system.foo` action throws when `actionManifest()` walks it. |
| 6 | `packages/cli/src/commands/list.ts` | `printActionDetail` becomes async. New helper `fetchActionMeta(peer, path)` that calls `peer.system.describe({ path })` and returns the full `ActionMeta`. Used only on the peer-source path; local-source path unchanged. |

### New test files

| File | Purpose |
|---|---|
| `packages/workspace/src/document/system-describe.test.ts` | E2E: two attached workspaces, peer A calls `system.describe('tabs.close')` on peer B over RPC, asserts returned `ActionMeta` includes the `input` schema. |
| `packages/cli/test/e2e-list-peer-detail.test.ts` (or extend existing) | E2E regression: `epicenter list --peer mac tabs.close` still renders the input fields section. |

## Dead code to remove (clean break)

- **No type orphans**: `ActionManifestEntry` was already aliased to `ActionMeta` per the prior unification spec. The arktype wire schema (`ActionManifestEntrySchema`) shrinks but its name stays.
- **No code orphans**: every reader of `entry.input` from the wire is the `list.ts` detail view, and that gets rewritten to fetch.
- **JSDoc cleanup**: `actions.ts:94` references `ActionManifestEntry` in prose: update to clarify wire vs local.
- **No spec deletions**: older specs (`20260424T180000-...`, `20260425T000000-...`, `20260426T000000-...`) historically described `input` on the wire. They stay as record. This spec supersedes them on the `input` question.

## Phases (ordered, each independently revertible)

### Phase 1: Wire schema + manifest builder

- [x] **1.1** `action-manifest.ts:31`: delete the `input` copy line.
- [x] **1.2** `action-manifest.ts walk()`: add `system.*` validator. Throw when `path.length === 0 && key === 'system'`.
- [x] **1.3** `standard-awareness-defs.ts:39`: drop `'input?': 'object'` from `ActionManifestEntrySchema`. Update JSDoc.
- [x] **1.4** `actions.ts:94` JSDoc: clarify that wire entries omit `input`; local `ActionMeta` retains it.
- [x] **1.5** `action-manifest.test.ts:48-50,62`: rewrite. New assertions: `expect(entry).not.toHaveProperty('input')`. Add a test for the validator throw.
- [x] **1.6** Run `bun test packages/workspace`. All pass.

### Phase 2: Inject `system.describe`

- [x] **2.1** `attach-sync.ts`: split `actions` into `userActions` (for manifest) and `actions` (for dispatch, includes `system.describe`).
- [x] **2.2** Implement `system.describe` handler: walks `userActions` by dotted path, returns full `ActionMeta` (with `input`). Returns `null` or throws `RpcError.ActionNotFound` if path doesn't resolve.
- [x] **2.3** Confirm `actionManifest(userActions)` still gets called with user-only tree; confirm validator catches accidental misordering.
- [x] **2.4** Add `packages/workspace/src/document/system-describe.test.ts`. Two attached workspaces, A calls B's `system.describe`. Asserts schema returned.
- [x] **2.5** Run `bun test packages/workspace`. All pass.

### Phase 3: CLI consumer

- [x] **3.1** `list.ts:357 printActionDetail`: make async. Add `peer?: PeerProxy` parameter.
- [x] **3.2** When `peer` is provided AND `action.input === undefined`, call `peer.system.describe({ path })` to fetch full meta. On RPC error, render whatever fields are available + a one-line "schema unavailable: <reason>" footer. Don't crash.
- [x] **3.3** Update `printActionDetail` callers: wherever `--peer` mode is wired, pass the peer proxy through.
- [x] **3.4** Add or extend `packages/cli/test/e2e-list-peer-detail.test.ts`: regression for "input fields section still renders for peer-mode detail."
- [x] **3.5** Run `bun test packages/cli`. All pass.

### Phase 4: Final verification

- [x] **4.1** `bun test` (full suite).
- [x] **4.2** Grep for any remaining stale references: `grep -rn "ActionManifestEntry" packages/` (should only hit JSDoc + the arktype schema definition, no orphans).
- [x] **4.3** Build the CLI: `bun run --filter @epicenter/cli build` (or whatever the build command is).
- [x] **4.4** Manual smoke: connect two workspaces locally, run `epicenter list --peer <name> <some.action>`, verify input fields render.

## Acceptance criteria

- Wire manifest size for an app with 20 actions: < 2kB.
- `bun test` green.
- `epicenter list --peer X some.action` shows input fields (now via RPC).
- Defining a user action at `system.foo` throws at workspace-bootstrap time with a clear message.
- No matches for `__describe__`, `__manifest__`, or any dunder pattern in production code.

## Open questions

None. All design decisions locked above.

## Migration / breaking change notes

This is a **wire-format breaking change**. Old peers publish `input` in their manifest; new peers ignore it (arktype schema rejects it strictly: verify behavior under the validator's `parse` semantics, may need `arktype.in`-style tolerance, or accept that mixed-version networks see manifest validation failures during the cutover). No backward-compat shim. The user explicitly asked for a clean break.

If wire validation strictness causes mixed-version pain during deploy, the fast fix is to widen `ActionManifestEntrySchema` to accept-and-ignore `input` for one release cycle, then tighten in a follow-up. Recommended: ship strict immediately and coordinate the deploy.
