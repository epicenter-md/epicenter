# CLI list unification: one renderer, one shape, one targeting flag

**Date:** 2026-04-26
**Status:** Draft
**Author:** AI-assisted (Braden + Claude)
**Branch:** `post-pr-1705-cleanup` (working branch: split into a feat branch on execution)

## One-sentence thesis

`epicenter list` becomes the single command for inspecting actions anywhere: local or any peer: by routing one renderer over one shape, while `peers` becomes a clean presence-only view.

## Overview

Today, action introspection is split across two CLI commands that don't share data or UX. `epicenter list` walks the local action tree and renders it nicely; `epicenter peers` reads remote awareness state and renders the action manifest as an opaque JSON blob in a `console.table` cell. The remote manifest is published by every app but never consumed legibly. This spec unifies the surface: `list` gains `--peer <name>` and `--all` to source from awareness instead of the local tree, sharing one renderer over the unified `ActionMeta` shape. `peers` keeps its job (presence) but stops trying to show offers.

**No command renames. No flag renames. No deprecation aliases.** Pure additive changes plus one column-removal in `peers`.

## Motivation

### Current state

```
epicenter list                  # walks LOCAL workspace.actions, pretty tree
epicenter list tabs.close       # local detail page

epicenter peers                 # console.table; offers shows as raw JSON cell:
                                # ┌──────────┬──────────────────────────────┐
                                # │ device   │ offers                       │
                                # ├──────────┼──────────────────────────────┤
                                # │ {…}      │ {"tabs.close":{"type":…},…}  │
                                # └──────────┴──────────────────────────────┘

epicenter run tabs.close        # local invoke
epicenter run --peer mac tabs.close   # remote invoke (already works)
```

This creates problems:

1. **The published manifest has no legible consumer.** Every app calls `awareness.setLocal({ device: { offers: actionManifest(actions) } })` at boot: four call sites today. Nothing reads it back as structured data. The `peers` table dumps it as a JSON string. The publication exists; the consumption doesn't.

2. **Asymmetric `--peer`.** You can invoke remotely (`run --peer mac`) but you cannot inspect remotely (`list` is local-only). The targeting axis exists for one verb, not both.

3. **Two near-identical metadata types.** `ActionMeta` (in `actions.ts`) and `ActionManifestEntry` (in `action-manifest.ts`) have identical fields at runtime. The renderer only reads metadata fields, so local `Action` and remote `ActionManifestEntry` are interchangeable for display: but the type system doesn't enforce that.

4. **Three parallel walks of the action tree.** `actionManifest`, `dispatchAction`, and the CLI's `walkActions` all do the same recursion. Each calls `path.join('.')` / `path.split('.')` independently. (Cosmetic, not load-bearing: see Design Decisions.)

### Desired state

```
epicenter list                         # local tree (today + unchanged)
epicenter list tabs.close              # local detail (unchanged)
epicenter list --peer mac              # mac's tree                     NEW
epicenter list --peer mac tabs.close   # mac's detail                   NEW
epicenter list --all                   # self + every connected peer    NEW
epicenter list --all tabs.close        # who offers it?                 NEW

epicenter peers                        # presence only                  TRIMMED

epicenter run tabs.close '{…}'         # local (unchanged)
epicenter run --peer mac tabs.close    # remote (unchanged)
```

One renderer. One `ActionMeta`-shaped data flow. Two commands that answer two distinct questions with no overlap.

## Research findings

### The three shapes already converge

```
ActionHandler          (the function the user writes: closes over deps)
  (input?) => R

ActionMeta             (the metadata fields)
  type:         'query' | 'mutation'
  title?:       string
  description?: string
  input?:       TSchema

Action = ActionHandler & ActionMeta       (callable + metadata, local only)

ActionManifestEntry    (what arrives over the wire as device.offers)
  type:         'query' | 'mutation'
  title?:       string
  description?: string
  input?:       object
```

`ActionManifestEntry` differs from `ActionMeta` only in that `input` is widened from `TSchema` to `object`. `TSchema` *is* a JSON object by construction, so the runtime values are bit-identical. The renderer in `list.ts:67-72, 122-183` reads only `type` / `description` / `input` from each leaf, never calls the action. So the distinction between `Action` and `ActionManifestEntry` is invisible to it.

### Existing primitives we can reuse

| Primitive | Location | What it does |
|---|---|---|
| `walkActions(actions)` | `packages/cli/src/util/walk-actions.ts:13` | Generator yielding `[dotPath, Action]` over a local tree |
| `findAction`, `actionsUnder` | same file | Local-tree subpath lookups |
| `printTree`, `printActionDetail` | `packages/cli/src/commands/list.ts:126, 172` | The renderer: already only reads metadata |
| `readPeers(workspace)` | `packages/cli/src/util/awareness.ts` | `Map<clientID, AwarenessState>` snapshot |
| `findPeer(workspace, name)` | `packages/cli/src/util/find-peer.ts` | Name → peer resolver used by `run --peer` |
| `actionManifest(actions)` | `packages/workspace/src/shared/action-manifest.ts:27` | Tree → flat `Record<dotPath, Entry>` |

**Key finding:** every primitive needed for the unified surface already exists. The local renderer is metadata-only. The peer resolver works. The remote manifest is published. **We're connecting wires, not building components.**

### CLI defaults: narrow vs wide

| CLI | Narrow (default) | Wide (flag) |
|---|---|---|
| `git log` | HEAD | `--all` (all refs) |
| `kubectl get` | current namespace | `--all-namespaces` |
| `docker ps` | running containers | `-a` (all) |
| `npm ls` | top-level deps | `--all` (transitive) |
| `ls` (Unix) | cwd | `-R` |

**Pattern:** default to the narrow/fast view; opt in to the cross-cutting view via `--all`. Reasoning is consistent: narrow is faster, more deterministic, predictable for scripts. `list --all` matches decades of muscle memory.

### Targeting flag conventions

| Tool | Targeting axis | Spelling |
|---|---|---|
| `kubectl` | cluster context | `--context <name>` |
| `docker` | daemon host | `--host <url>` |
| `gh` | repo | `--repo <owner/name>` |
| `aws` | profile | `--profile <name>` |
| `ssh` | host | `user@host` (positional) |

**Pattern:** name what the target *is* (`--context`, `--host`, `--repo`). Zero CLIs spell the targeting axis with a preposition. `--peer` (already in use) names the thing; alternative `--on` would be coined-on-the-spot.

### Why `peers` and `list` should remain separate commands

A peer can be online with zero offers (reduced privileges, debug build, app didn't publish). Presence and capability are genuinely separable:
- `peers` answers "who's reachable right now?": heartbeat, last-seen, connection.
- `list --all` answers "what can I run anywhere?": capability inventory.

Forcing presence through an action-listing command requires a `--depth 0` workaround that reads as "actions, but with no actions." Two commands, two questions, zero overlap.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Add remote source to `list`? | Yes: via `--peer` and `--all` | Local and remote actions are the same shape; the only axis is *where*. Asymmetry with `run --peer` is unjustified. |
| Rename `list` → `actions`? | **No** | Cosmetic. `list` works alone, has no migration cost, and no functional improvement comes from renaming. |
| Targeting flag spelling | `--peer <name>` | Already exists, matches CLI convention (name what the target IS), zero migration. |
| Fan-out spelling | `--all` | Matches `git log --all`, `npm ls --all`, `docker ps -a` precedent. Avoids `--on '*'` shell-quoting hazard. |
| Default scope of `list` | Local only (no flag = self) | Speed (instant, no network), determinism (same input → same output), use-case fit (development is the dominant case; "what does my code expose" is local-state). Matches `git log` / `kubectl get` defaulting convention. |
| Keep `peers`? | Yes, but trimmed | Presence is meaningfully separate from capability (offline-but-connected peers exist). Drop the offers-as-JSON-blob column; everything else stays. |
| Type dedup | `ActionManifestEntry = ActionMeta` | Fields are identical at runtime; one type makes the renderer's source-agnostic contract enforceable. |
| Deprecation aliases (`list` ↔ `actions`, `--peer` ↔ `--on`) | **Not needed**: nothing is renamed | No churn = nothing to deprecate. Pre-1.0 dev CLI without a published-consumer surface anyway. |
| `--peer` and `--all` combined | **Hard error** with usage message | Flags express incompatible intents (`--all` already includes everyone). Hard error is more honest than silent precedence. |
| Show offline peers in `--all`? | **No: impossible by design** | Yjs awareness is presence-only: y-sweet broadcasts removal on disconnect, this repo's `attach-sync.ts:545-556` wipes remote states on `ws.onclose`, no on-disk persistence, clientIDs randomize per `Y.Doc`. "Offline peer" is not a coherent concept under y-protocols. To list disconnected peers, you'd need a separate persisted device directory: out of scope. |
| `--wait` default | `500` ms | `whenConnected` resolves after the sync handshake (STEP1/STEP2 round-trip). Server sends `AWARENESS(all clients)` in the initial burst, processed before STEP2 by TCP/WS in-order delivery: so 0 is *usually* enough. But concurrent peer joins, server batching variance, and event-loop jitter can leave the snapshot empty. 500ms is imperceptible interactively, eliminates "peer not found" false negatives, and scripts can still pass `--wait 0` for strict one-shot semantics. |
| `peer:path` colon syntax (`run mac:tabs.close`) | **Deferred** | Tempting but ties peer-targeting to positional shape, which doesn't extend uniformly to future peer-shaped commands (`trust`, `ping`, etc.). `--peer` is uniform across commands. Reconsider as additive sugar later if demand appears. |
| `run --all` (any-peer routing) | **Deferred** | Real future feature ("first peer that offers it"). Premature without a concrete consumer. |
| Hoist `walkActions` into `@epicenter/workspace` | **Deferred** | Three callers exist (manifest, dispatch, CLI), but each is small and pure. Cosmetic dedup; revisit only if a fourth caller appears. |
| Cache flattened actions in dispatch path | **Rejected** | Adds state for microsecond gain. Pure functions over per-call walks beat cached state, every time. |

## Architecture

### Data flow today

```
publication side (boot, every app):

  workspace.actions ─► actionManifest() ─► awareness.setLocal({ device: { offers } })
                              │
                              └─ walks tree, dot-joins paths

local CLI side:

  workspace.actions ─► walkActions() ─► printTree / printActionDetail
                              │
                              └─ second walk, second dot-join

remote CLI side:

  awareness.peers().get(id).device.offers ─► console.table CELL (JSON blob)
                                                                  ▲
                                                          THE BUG: opaque
```

### Data flow after this spec

```
                    ┌── walkActions() ──► Map<dotPath, Action>      (local, default)
                    │
                    │                          │  pick metadata
  workspace.actions ┤                          ▼
                    │                     Map<dotPath, ActionMeta>  ──┐
                    │                                                 │
                    └── actionManifest() ─► Record<dotPath, ActionMeta>
                                            (published in awareness)  │
                                                                      │
                    awareness.peers().get(id).device.offers ──────────┤
                              (read when --peer or --all is set)      │
                                                                      ▼
                                                        ONE renderer (tree | detail | json)
                                                          source-agnostic; reads metadata only
```

### Output examples

```
$ epicenter list
my-workspace
├── tabs
│   ├── close   (mutation)  Close one or more tabs
│   └── list    (query)     List all open tabs
└── entries
    └── create  (mutation)  Create an entry

$ epicenter list --peer mac tabs.close
mac:tabs.close  (mutation)
  Close one or more tabs

  Input fields (pass as JSON):
    tabIds: array  (required)

$ epicenter list --all
self (this device)
├── tabs.close       (mutation)
└── entries.create   (mutation)

mac (online)
├── tabs.close       (mutation)
└── tabs.list        (query)

ipad (online, offers: 0)

$ epicenter peers
┌─────────┬────────────┬──────────┬──────────┐
│ name    │ deviceId   │ clientID │ online   │
├─────────┼────────────┼──────────┼──────────┤
│ mac     │ 0x1f2…     │ 184729   │ now      │
│ ipad    │ 0xa84…     │ 184731   │ now      │
└─────────┴────────────┴──────────┴──────────┘
```

## Implementation plan

### Phase 1: type dedup and renderer generalization (no behavior change)

- [x] **1.1** Export `ActionMeta` from `packages/workspace/src/shared/actions.ts`. Today it's a non-exported type alias.
- [x] **1.2** In `packages/workspace/src/shared/action-manifest.ts`, replace the local `ActionManifestEntry` definition with `export type ActionManifestEntry = ActionMeta`. Verify with `bun test packages/workspace`.
- [x] **1.3** In `packages/cli/src/commands/list.ts`, change `printTree`, `printActionDetail`, `describeAction` parameter types from `Action` to `ActionMeta`. Verify with `bun test packages/cli`: existing local-mode tests should pass unchanged.

### Phase 2: remote source for `list`

- [x] **2.1** Add `--peer <name>` option to `list`. When set, resolve the peer via `findPeer(workspace, name)`, source from `peer.device.offers ?? {}` (already shape `Record<dotPath, ActionMeta>` after Phase 1), and route through the existing renderer.
- [x] **2.2** Add `--all` option. Iterate `readPeers(workspace)`, render one section per peer (text mode) or `{ peer, path, ...meta }` rows (JSON mode). Include self as the first section.
- [x] **2.3** When `--peer` and `--all` are both set, fail with a hard usage error: `--peer and --all are mutually exclusive (--all already includes every peer)`. Exit non-zero before opening sync.
- [x] **2.4** Add a `--wait <ms>` option for the `--peer` and `--all` paths. **Default: 500.** Default `list` (no flag) doesn't open sync at all.

### Phase 3: `peers` slim-down

- [x] **3.1** In `packages/cli/src/commands/peers.ts`, restrict `buildPeerRows` to presence-only keys (`device.id`, `device.name`, `clientID`, online-since). Drop the `offers` column entirely. Update `peers.test.ts` accordingly.
- [x] **3.2** Update the command's `describe:` string to reflect the slimmer purpose ("List connected peers (presence). Use `list --peer` or `list --all` for action introspection.").

### Phase 4: docs

- [x] **4.1** Update CLI README in `packages/cli/README.md` with the new `list --peer` / `list --all` surface.
- [ ] **4.2** Add a changelog entry in the CLI package. _(Skipped: package has no CHANGELOG.md today.)_

## Testing strategy

The CLI uses two test layers, both via `bun:test` (`bun test packages/cli`). This spec adds tests at both layers. Test file conventions follow `packages/cli/src/commands/peers.test.ts` (unit-style, next to the command) and `packages/cli/test/e2e-inline-actions.test.ts` (e2e against a fixture workspace).

### Unit tests: pure helpers

Extract pure functions from `list.ts` so they can be tested without spinning up a workspace. Mirror the pattern `peers.test.ts` already uses for `buildPeerRows`.

#### `packages/cli/src/commands/list.test.ts` (new)

```ts
import { describe, expect, test } from 'bun:test';
import { sourceLocal, sourcePeer, sourceAll } from './list';
//   sourceLocal(actions): Map<dotPath, ActionMeta>
//   sourcePeer(workspace, name): Map<dotPath, ActionMeta>
//   sourceAll(workspace): Array<{ peer: string, entries: Map<dotPath, ActionMeta> }>

describe('sourceLocal', () => {
  test('returns flat dot-path map over a nested action tree');
  test('preserves type/title/description/input metadata on each entry');
  test('returns empty map for an empty actions object');
});

describe('sourcePeer', () => {
  test('reads device.offers from awareness for a named peer');
  test('returns empty map when peer has no offers field');
  test('throws PeerNotFound when the name does not resolve');
});

describe('sourceAll', () => {
  test('returns one section for self plus one per connected peer');
  test('peer with offers: undefined renders with empty entries (not omitted)');
  test('preserves peer ordering: self first, then by clientID asc');
});
```

The renderer functions (`printTree`, `printActionDetail`) take an `ActionMeta`-keyed map; we test them on local AND remote shapes to enforce the source-agnostic contract:

```ts
describe('printTree (renderer accepts ActionMeta from any source)', () => {
  test('renders identical output for local Action and remote ActionManifestEntry with same metadata');
  test('groups by dot-path segments into a tree shape');
  test('marks each leaf with (query) or (mutation)');
  test('appends description after type when present');
});

describe('describeAction → JSON shape', () => {
  test('emits { path, type, description?, input? } for local source');
  test('emits identical shape for remote source');
});
```

#### `packages/cli/src/commands/peers.test.ts` (modified)

```ts
describe('buildPeerRows after offers-column removal', () => {
  test('returned rows include only presence keys: clientID, device.id, device.name, online-since');
  test('ignores device.offers even when present in awareness state');
  test('rows are sorted by clientID asc (regression of existing behavior)');
});
```

### E2E tests: fixture workspace

Extend `packages/cli/test/e2e-inline-actions.test.ts` (or add `e2e-list-peer.test.ts`) using the existing `fixtures/inline-actions` fixture. The fixture already exposes a `counter` action tree.

To exercise remote-source paths without standing up a real second peer, manually populate awareness on the fixture workspace:

```ts
import { actionManifest } from '@epicenter/workspace';

beforeAll(async () => {
  loaded = await loadConfig(FIXTURE_DIR);
  const { workspace } = loaded.entries[0]!;
  // Simulate a remote peer by writing into awareness directly.
  workspace.awareness.peers().set(999, {
    device: { id: 'fake-mac', name: 'mac', offers: actionManifest(workspace.actions) },
  });
});
```

#### Test cases

```ts
describe('list (default: local source)', () => {
  test('emits the local action tree with no network access');
  test('matches snapshot of pre-spec `list` output (regression guard)');
});

describe('list --peer <name>', () => {
  test('renders the peer\'s action tree using the same renderer as local');
  test('exits non-zero with peer-not-found message for unknown name');
  test('--peer self is equivalent to no flag');
  test('--peer mac tabs.close renders the detail page for that remote action');
});

describe('list --all', () => {
  test('emits self section first, then one section per connected peer');
  test('with no peers, output equals the local-only output');
  test('renders peers with offers: undefined as a header with no children');
  test('JSON mode emits one row per (peer, path) tuple with peer field set');
});

describe('list --peer + --all combined', () => {
  test('exits non-zero with usage error before opening sync');
  test('error message names both flags and explains the conflict');
});

describe('list --wait', () => {
  test('default (--wait 500) polls awareness up to the deadline');
  test('--wait 0 is a one-shot snapshot, no polling');
  test('--wait 2000 keeps polling for slow networks');
});
```

#### `run --peer` regression (already works, tested for safety)

```ts
describe('run --peer (unchanged behavior)', () => {
  test('invokes against the resolved peer\'s actions');
  test('exits non-zero on peer-not-found');
});
```

### Snapshot / golden output

Where ASCII tree output is compared against expected strings (regression for renderer changes), use `expect(stdout).toMatchSnapshot()` or inline expected strings: pick the latter when the output is short enough for a literal expected value to read clearly. Avoid screenshot-style snapshots that bloat over time.

### Type-level test

Add a one-time type assertion to lock the dedup invariant:

```ts
// packages/workspace/src/shared/action-manifest.test.ts (new or extend existing)
import { expectTypeOf } from 'expect-type';
import type { ActionMeta } from './actions';
import type { ActionManifestEntry } from './action-manifest';

test('ActionManifestEntry is structurally identical to ActionMeta', () => {
  expectTypeOf<ActionManifestEntry>().toEqualTypeOf<ActionMeta>();
});
```

If the project doesn't have `expect-type` already, use the existing `tsd`-style approach in the repo, or just enforce via a `// @ts-expect-error`-anchored compile check.

### How to run

```sh
bun test packages/cli       # unit + e2e for the CLI package
bun test packages/workspace # type-dedup invariant + existing manifest tests
bun test                    # everything (CI-equivalent)
```

## Edge cases

### Peer is connected but `device.offers` is undefined
Possible during boot before the app has called `setLocal`, or if an app opts out. Treat as empty map: render the peer section with `(offers: 0)` annotation in text mode; emit zero rows in JSON mode. **Don't error.** Tested in `sourcePeer` and `list --all`.

### `--peer <name>` when no peer matches
Use the existing `findPeer` error path from `run --peer`. Same exit code and message shape.

### Awareness hasn't populated by the time `--peer` or `--all` runs
Default `--wait 500` polls for up to 500ms after `whenConnected` resolves. This catches the initial awareness burst that arrives in the same write window as the sync handshake, plus a small grace period for concurrent peer joins or event-loop jitter. Scripts wanting strict one-shot semantics pass `--wait 0`. Users with slow links or laggy peers pass higher values (e.g. `--wait 2000`).

### `--all tabs.close` when path exists on some peers but not others
Render only the peers that offer it. If zero peers offer it (and self doesn't either), exit non-zero with `path not found on any peer`.

### `--peer` and `--all` both set
Hard error before opening sync: `--peer and --all are mutually exclusive`. Exit non-zero. The flags express incompatible intents and silent precedence would mask user mistakes.

### Local action exists but isn't in self's `offers` (or vice versa)
Shouldn't happen: `actionManifest(actions)` is called over the same tree at boot. If they diverge, treat as a publishing bug, not a CLI concern.

## Open questions

1. **Should `peers` default `--wait` change too (currently 0) for symmetry with `list --all`?**
   - `peers` today defaults `--wait 0`: the same arguments about cold-start empty snapshots apply.
   - **Recommendation:** Yes, change `peers` to `--wait 500` in the same change for consistency. Mention in changelog.

2. **Hoist `walkActions` into `@epicenter/workspace`?**
   - Three callers walk the action tree (`actionManifest`, `dispatchAction`, CLI's `walkActions`).
   - **Recommendation:** Defer. Cosmetic dedup; the three implementations are small, pure, and stable. Revisit if a fourth caller appears.

## Success criteria

- [ ] `epicenter list` (no flag) reproduces today's output exactly (regression guard via snapshot).
- [ ] `epicenter list --peer <name>` renders a remote peer's action tree using the same renderer as the local view.
- [ ] `epicenter list --all` renders self plus every connected peer in one invocation.
- [ ] `epicenter peers` no longer shows an `offers` column.
- [ ] `epicenter run --peer <name> <path>` works identically to today.
- [ ] `ActionManifestEntry` and `ActionMeta` are the same type (enforced by type-level test).
- [ ] No changes to `packages/workspace/src/shared/action-manifest.ts` runtime behavior.
- [ ] No changes to the wire format, awareness shape, or RPC dispatch path.
- [ ] `bun test packages/cli` and `bun test packages/workspace` pass.
- [ ] CLI README documents the new flags.

## References

- `packages/cli/src/commands/list.ts`: current local renderer; gains `--peer` and `--all`.
- `packages/cli/src/commands/peers.ts`: `buildPeerRows` to slim down.
- `packages/cli/src/commands/run.ts`: unchanged; `--peer` already works.
- `packages/cli/src/commands/peers.test.ts`: pattern for unit tests on pure helpers.
- `packages/cli/test/e2e-inline-actions.test.ts`: pattern for fixture-based e2e tests.
- `packages/cli/test/fixtures/inline-actions/`: existing fixture workspace.
- `packages/cli/src/util/walk-actions.ts`: local source iterator (unchanged).
- `packages/cli/src/util/awareness.ts`: `readPeers` for awareness snapshot.
- `packages/cli/src/util/find-peer.ts`: peer name resolver (unchanged).
- `packages/workspace/src/shared/actions.ts`: `ActionMeta` to export.
- `packages/workspace/src/shared/action-manifest.ts`: `ActionManifestEntry` to alias.
- `packages/workspace/src/document/standard-awareness-defs.ts`: defines `device.offers` shape on the awareness wire.
- `specs/20260425T000000-device-actions-via-awareness.md`: original publication design.
- `specs/20260425T210000-remote-action-dispatch.md`: peer Proxy and `actionManifest`; this spec consumes what that one publishes.
