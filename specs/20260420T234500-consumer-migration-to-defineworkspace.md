# Consumer migration to `defineWorkspace`: unblock, redesign, execute

**Date**: 2026-04-20
**Status**: Draft
**Follows**: `specs/20260420T230200-workspace-as-definedocument.md` (partial)

## TL;DR

Spec C (`workspace-as-definedocument`) landed the architectural core:
`defineWorkspace` is now a `DocumentFactory`-based factory-of-factories,
encryption/tables/kv are standalone attachments, and the per-call
`createWorkspace` builder persists as a transitional shim that keeps
all seven consumer apps building unchanged. The spec's consumer-facing
success criteria (delete `createWorkspace`, migrate apps, zero
references to legacy types) couldn't land cleanly because migrating the
first consumer surfaced two dependencies Spec C didn't anticipate:

1. `@epicenter/document`'s `attachSync` doesn't expose
   `hasLocalChanges` on its `SyncStatus`. The shared
   `SyncStatusPopover` reads this to gate a safe-sign-out
   confirmation.
2. `SyncStatusPopover` is structurally coupled to the legacy
   workspace client shape (`workspace.extensions.sync.*`,
   `workspace.clearLocalData()`). Migrating any one app forces either
   per-app compat shim debt or a cross-app popover refactor.

This spec lands both unblocks and executes the consumer migration in
one sequenced arc. Three phases, each small; combined they finish the
work Spec C started.

## Phase 1: `hasLocalChanges` on `attachSync.SyncStatus`

### Motivation

"Is there data only on this device that the server hasn't
acknowledged yet?" is a universal local-first concern. Every app that
signs users out wants to warn before wiping local state with unsynced
work. The old `createSyncExtension` in `@epicenter/workspace` exposed
this as `SyncStatus.hasLocalChanges` because the extension chain
wired the sync-ack protocol visibility through its init chain.
`attachSync` in `@epicenter/document`: the user-composed replacement
Source: dropped this field when the surface simplified.

The protocol already carries the information. The server's
`SYNC_STATUS` message acknowledges a specific doc version; if the
client's current version is ahead of that ack, there's local work
that hasn't round-tripped yet. Computing `hasLocalChanges` is a diff
between two integers the supervisor already tracks.

### Scope

- `@epicenter/document/src/attach-sync.ts`: track the
  last-acknowledged version from `SYNC_STATUS` messages; expose
  `hasLocalChanges` on the `{ phase: 'connected', ... }` variant of
  `SyncStatus`. Keep `phase: 'offline' | 'connecting'` variants
  unchanged: `hasLocalChanges` is meaningful only while connected.
- Emit a status change whenever the diff flips (true ↔ false).
- Unit test: simulate a sync-ack round-trip, assert the flag toggles
  correctly.

### Non-goals

- Changes to the sync protocol wire format. The `SYNC_STATUS` message
  already carries what we need; this is a consumer-side projection.
- Changes to `@epicenter/sync`. Protocol codecs unchanged.
- Changes to the extension-chain `createSyncExtension` in
  `@epicenter/workspace`. It's slated for deletion in Phase 3; no
  point maintaining parallel implementations.

### Acceptance

```ts
type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; attempt: number; lastError?: SyncError }
  | { phase: 'connected'; hasLocalChanges: boolean };
```

Unit test passes; `attachSync` consumers can read
`status.hasLocalChanges` and subscribe to its changes via
`onStatusChange`.

Estimated size: ~30-50 LOC plus one test.

## Phase 2: `AccountPopover` redesign

### Motivation

The popover today at
`packages/svelte-utils/src/sync-status-popover/sync-status-popover.svelte`
is named after one of three things it does. It shows the user's
auth state, displays sync health, exposes reconnect and sign-out
actions, and gates sign-out when there's unsynced work. Name and
interface both need rework.

The structural coupling to the old client shape
(`workspace.extensions.sync.*`, `workspace.clearLocalData()`) makes
any single-app migration expensive. The app either reinvents the
legacy surface locally or waits for the popover to be decoupled.
Decoupling it once, with the right abstraction, unblocks the
per-app migration cleanly.

### Design

#### Shape: `SyncView`-bag prop

The popover consumes sync as a single conceptual bag. Passing it as
one prop reads better than unwrapping it into four individual
callbacks:

```ts
type SyncView = {
  status: SyncStatus;                                           // reactive
  reconnect: () => void;
  onStatusChange: (cb: (s: SyncStatus) => void) => () => void;
};

type AccountPopoverProps = {
  auth: AuthClient;
  sync: SyncView;
  onLocalClear: () => Promise<void>;
  noun: string;
  onSocialSignIn: () => Promise<{ error: { message: string } | null }>;
};
```

Three conceptual props per app instead of four. The `sync` bag stays
coherent. An app never pulls `reconnect` out of sync's orbit.

#### Works for both workspace clients during the migration window

- Apps still on the `createWorkspace` shim pass
  `sync={workspace.extensions.sync}`.
- Apps migrated to `defineWorkspace(def).open(id)` pass
  `sync={workspace.sync}`.

Both satisfy `SyncView` structurally because
`{ status, reconnect, onStatusChange }` is the same shape in either
world. No runtime dispatch, no version branch, no conditional
imports.

#### Safe-sign-out stays opinionated, owned by the component

The component reads `sync.status.hasLocalChanges` (after Phase 1)
and gates sign-out with a confirmation when unsynced work exists.
Universal local-first behavior; centralizing it gives one place to
tune copy, retry behavior, dialog styling.

Apps with stricter policies get an escape hatch via an optional
`canSignOutSafely?: () => boolean` predicate. Default behavior:
check `phase === 'connected' && !hasLocalChanges`: stays the
component's responsibility.

#### Rename

`SyncStatusPopover` → `AccountPopover`. The popover's primary
affordance is the user pill; sync health is one signal it shows.
Rename matches what it is.

### Scope

- New component file
  `packages/svelte-utils/src/account-popover/account-popover.svelte`
  implementing the above shape.
- New barrel entry in `packages/svelte-utils/src/index.ts`.
- Leave the old `sync-status-popover.svelte` in place; mark
  deprecated in a JSDoc header. Delete during Phase 3 once every app
  migrates its call site.
- Update the popover's tests (if any) to the new shape.

### Non-goals

- Changes to the auth client (`createAuth`). The popover's auth
  interaction surface stays unchanged: sign-in, sign-out, signed-in
  state reads.
- Splitting the popover into separate sync/auth sub-components. The
  popover is a single user-recognizable UI affordance; splitting
  serves no caller.
- Migrating to a different UI library or design system.

### Acceptance

- `AccountPopover` component compiles, renders, and passes its own
  tests with the new shape.
- Both the legacy `workspace.extensions.sync` and the new
  `workspace.sync` satisfy the `SyncView` prop type without casts.

Estimated size: ~150 LOC new component (mostly existing popover
logic reshaped) + tests.

## Phase 3: Per-app migration + shim deletion

### Motivation

With Phases 1 and 2 landed, per-app migration becomes mechanical.
Each app:

- Replaces `createWorkspace(def).withExtension(...).withActions(...)`
  with an app-owned wrapper that composes `attachIndexedDb` +
  `attachSync` on top of `defineWorkspace(def).open(id)` and layers
  actions.
- Replaces `workspace.applyEncryptionKeys(...)` with
  `workspace.enc.applyKeys(...)`.
- Replaces `workspace.clearLocalData()` with direct persistence
  cleanup (`await workspace.idb.clearLocal()`).
- Updates layout files to render `<AccountPopover>` instead of
  `<SyncStatusPopover>`, wiring the new prop shape.

Once the last app migrates, `createWorkspace`, `lifecycle.ts`, the
legacy `SyncStatusPopover`, and all extension-chain types get
deleted.

### The seven apps

In rough order of complexity:

1. [x] **breddit**: test-only usage; grep and delete.
2. [x] **zhongwen**: smallest runtime app; uses broadcast, not
   websocket. Template for the "no sync extension" case.
3. [x] **fuji**: mid-complexity, straightforward tables + sync.
   Template for the standard "IDB + sync" composition.
4. [x] **honeycrisp**: similar to fuji. Straightforward.
5. [ ] **whispering**: has a custom materializer extension. Materializer
   becomes a user-owned wrapper around the base handle.
6. [ ] **tab-manager**: sync with RPC dispatch. Actions compose
   specially.
7. [ ] **opensidian**: most complex; sqlite-index extension plus sync.
   Sqlite index becomes a user-owned wrapper.

Each app migrates in its own commit with its own PR if useful. The
per-app pattern from the migration of app #3 (fuji) becomes the
template the remaining four follow.

### Shim deletion

After all seven apps migrate:

- Delete `packages/workspace/src/workspace/create-workspace.ts`.
- Delete `packages/workspace/src/workspace/create-workspace.test.ts`
  (the extension-chain and actions tests migrate to the relevant
  attachments' own tests; the batch tests move to the new
  `WorkspaceBundle`'s `batch` method test).
- Delete `packages/workspace/src/workspace/lifecycle.ts`.
- Delete the `SyncStatusPopover` component from `@epicenter/svelte-utils`.
- Prune types from `packages/workspace/src/workspace/types.ts`:
  `WorkspaceClient`, `WorkspaceClientBuilder`, `ExtensionContext`,
  `SharedExtensionContext`, `RawExtension`, `ExtensionFactory`.
- Update barrel exports to match.
- Remove `.definition` from `WorkspaceFactory`'s public type (it
  existed only so the shim could recover the config; with the shim
  gone, it's dead weight).

### Non-goals

- Changes to any app's feature set. This is a plumbing migration
  only.
- Changes to any app's sync protocol wire format or auth flow.
- Changes to `packages/cli` or `packages/skills` consumers: those
  follow the same migration pattern, covered implicitly by the "zero
  references to legacy types" success criterion.

### Acceptance

- Every app in `apps/*` builds without importing `createWorkspace`,
  `SyncStatusPopover`, or any extension-chain type.
- `grep -r 'createWorkspace\\|WorkspaceClientBuilder\\|withExtension\\|SyncStatusPopover' apps/ packages/` returns only archived-spec hits.
- `bun run build` clean at repo root.
- Smoke test: in fuji, create an entry, type into the rich-text
  editor, reload the page, confirm persistence. Sign in (encryption
  activates), sign out with the dialog gate behaving correctly when
  local changes exist.

## Success Criteria

- [ ] `attachSync.SyncStatus['connected']` carries
  `hasLocalChanges: boolean`.
- [ ] `AccountPopover` component exists; `SyncStatusPopover` is
  deprecated and removed after all call sites migrate.
- [ ] `createWorkspace`, `lifecycle.ts`, extension-chain types, and
  legacy test files are deleted.
- [ ] Every app in `apps/*` uses `defineWorkspace(def).open(id)` +
  user-owned wrappers; no extension chain anywhere.
- [ ] `bun test` and `bun run build` clean across the repo.
- [ ] Smoke test passes in fuji (and honeycrisp as a second
  migration anchor).
- [ ] Spec C's deferred success criteria flip to `[x]`.

## Sequencing

Phases are strictly sequenced. Phase 2 depends on Phase 1's
`hasLocalChanges`. Phase 3 depends on Phase 2's `AccountPopover`. The
sequence is why this is one spec with three phases rather than three
separate specs: interleaving phases creates interstitial migrations
that cost more than the sum of the parts.

## Non-Goals (spec-wide)

- Changes to the sync wire protocol.
- Changes to the crypto layer or encryption semantics.
- Architectural changes to `defineDocument` or the refcounted cache.
- Promotion of `EncryptedYKeyValueLww` from `@epicenter/workspace` to
  `@epicenter/document`: separate spec, flagged in Spec C's
  Execution Notes.

## References

### Files created

- `packages/svelte-utils/src/account-popover/account-popover.svelte`
- (new tests as needed)

### Files modified

- `packages/document/src/attach-sync.ts` (Phase 1)
- Every `apps/*/src/lib/client.ts` and equivalent (Phase 3)
- Every `apps/*/src/lib/workspace.ts` and equivalent (Phase 3)
- Every app's layout file that renders the popover (Phase 3)
- `packages/workspace/src/workspace/types.ts` (Phase 3 prune)
- `packages/workspace/src/index.ts` and
  `packages/workspace/src/workspace/index.ts` (Phase 3 barrel
  updates)

### Files deleted (end of Phase 3)

- `packages/workspace/src/workspace/create-workspace.ts`
- `packages/workspace/src/workspace/create-workspace.test.ts`
- `packages/workspace/src/workspace/lifecycle.ts`
- `packages/svelte-utils/src/sync-status-popover/sync-status-popover.svelte`

### Follow-ups to revisit after Phase 3

- If `SyncView` has zero external consumers after the 4-app popover
  migration, inline it into `account-popover.svelte` and drop
  `packages/svelte-utils/src/account-popover/types.ts`.
- If at that point the only thing in
  `packages/svelte-utils/src/account-popover/index.ts` is the default
  export, consider consolidating (drop the barrel or collapse the
  folder).

### Prior art

- `specs/20260420T230200-workspace-as-definedocument.md`: Spec C,
  this spec's predecessor
- `specs/20260420T230100-collapse-document-framework.md`: Spec B
- `specs/20260420T220000-simplify-definedocument-primitive.md`:
  Spec A
