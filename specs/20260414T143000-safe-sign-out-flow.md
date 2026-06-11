# Safe Sign-Out Flow

**Date**: 2026-04-14
**Status**: Superseded by `specs/20260504T233223-sign-out-preserves-local-data.md`
**Author**: AI-assisted

## Overview

Superseded note, 2026-05-05: this draft assumed sign-out must guard
against data loss because sign-out wiped local IndexedDB. The replacement
spec removes that premise. Sign-out now tears down runtime state and reloads,
while owner-scoped local persistence is preserved. Explicit local deletion is
handled by "Forget this device."

Add a safe sign-out flow across all 5 workspace apps that checks sync status before signing out, warns users about unsynced changes, and does a clean page reload to eliminate in-memory state leakage.

## Motivation

### Current State

Every app wires the same `onLogout` callback:

```ts
// apps/{honeycrisp,fuji,opensidian,tab-manager}/src/lib/client.ts
onLogout() {
  workspace.clearLocalData();
  workspace.extensions.sync.reconnect(); // useless. Token is null
}
```

Sign-out buttons just call `await auth.signOut()` with no pre-checks:

```svelte
<!-- AccountPopover / SyncStatusIndicator -->
<Button onclick={async () => {
  await auth.signOut();
  popoverOpen = false;
}}>
  Sign out
</Button>
```

This creates problems:

1. **Silent data loss**: `clearLocalData()` wipes IndexedDB immediately. Any unsynced local changes (offline edits, slow network) are permanently destroyed with no warning.
2. **Useless reconnect**: `reconnect()` after logout fails because `auth.token` is null. It's dead code.
3. **In-memory ghost data**: The workspace Y.Doc is a module-level singleton that survives logout. Encryption keys have no deactivation path. UI bindings remain active. A different user logging in on the same browser could see stale decrypted data.
4. **Race condition**: `clearLocalData()` returns a Promise but isn't awaited. `reconnect()` fires while the IndexedDB wipe is still running.
5. **BroadcastChannel repopulation**: BC sync stays active until `dispose()`, not `clearLocalData()`. Other tabs can push updates back into IndexedDB during the sign-out window.

### Desired State

```
User clicks "Sign out"
  → Check sync status (is everything synced?)
  → If unsynced: show confirmation dialog with warning
  → If synced (or user confirms):
      await auth.signOut()
      await workspace.clearLocalData()
      window.location.reload()     ← clears ALL in-memory state
```

The page reload eliminates the need for encryption deactivation, workspace teardown, in-memory clearing, and UI auth gating. It's the simplest approach that solves every identified problem.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Pre-check mechanism | Snapshot `workspace.extensions.sync.status` at click time | No reactive subscription needed for a one-time check |
| "Safe to logout" signal | `phase === 'connected' && !hasLocalChanges` | `hasLocalChanges` tracks `localVersion > ackedVersion`: exactly "are all my edits acknowledged?" |
| Warning UI | `confirmationDialog.open()` from `@epicenter/ui` | Already used by fuji/opensidian for destructive actions. Imperative API, mounts once in layout. |
| Typed confirmation input | No | Signing out isn't permanently destructive (server has synced data). A destructive confirm button with clear copy is sufficient. |
| Post-signout cleanup | `window.location.reload()` | Atomically clears: in-memory Y.Doc, encryption keys, Svelte stores, BroadcastChannel, WebSocket. No partial teardown. |
| `onLogout` callback role | Fallback for server-initiated revocation | Handles session expiry, admin revocation. Cases where the UI handler didn't run. Same flow: clear + reload. |
| Zhongwen handling | `onLogout` reload only | No sign-out button exists, no websocket sync (broadcast channel only). Only needs the `onLogout` fallback fix. |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Sign-Out Flow                         │
├──────────────────────┬──────────────────────────────────┤
│  USER-INITIATED      │  SERVER-INITIATED                │
│  (button click)      │  (session expired/revoked)       │
│                      │                                  │
│  1. Check sync       │  1. Better Auth subscription     │
│     status snapshot  │     detects auth→anon            │
│  2. If unsynced:     │  2. onLogout() fires             │
│     show dialog      │  3. clearLocalData()             │
│  3. signOut()        │  4. reload()                     │
│  4. clearLocalData() │                                  │
│  5. reload()         │                                  │
└──────────────────────┴──────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Fix `onLogout` in all 5 apps (the fallback path)

- [ ] **1.1** `apps/honeycrisp/src/lib/client.ts`: Replace `onLogout` body: remove `reconnect()`, add `await clearLocalData()` then `window.location.reload()`
- [ ] **1.2** `apps/fuji/src/lib/client.ts`: Same change
- [ ] **1.3** `apps/opensidian/src/lib/client.ts`: Same change
- [ ] **1.4** `apps/tab-manager/src/lib/client.ts`: Same change
- [ ] **1.5** `apps/zhongwen/src/lib/client.ts`: Same change (zhongwen already omits `reconnect()`, just add reload)

### Phase 2: Add sync status check + confirmation dialog to sign-out buttons (4 apps)

- [ ] **2.1** `apps/honeycrisp`: Mount `<ConfirmationDialog />` in `+layout.svelte` (fuji/opensidian/tab-manager already have it)
- [ ] **2.2** `apps/honeycrisp/src/lib/components/AccountPopover.svelte`: Replace sign-out click handler with sync check → confirmation dialog → signOut → clearLocalData → reload
- [ ] **2.3** `apps/fuji/src/lib/components/SyncStatusIndicator.svelte`: Replace sign-out click handler with same pattern
- [ ] **2.4** `apps/opensidian/src/lib/components/SyncStatusIndicator.svelte`: Same change
- [ ] **2.5** `apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte`: Same change

### Phase 3: Verify

- [ ] **3.1** Run `bun run typecheck` across affected packages
- [ ] **3.2** Verify no LSP diagnostics on changed files

## Edge Cases

### signOut() fails (network error)

1. POST /sign-out fails
2. `auth.signOut()` swallows the error (existing behavior in `create-auth.svelte.ts`)
3. Our UI handler still runs `clearLocalData()` + `reload()` after signOut returns
4. Result: local state is wiped even if server session wasn't revoked. On reload, the persisted session in localStorage was already set to null by the Better Auth subscription, so the user lands unauthenticated. If the server session survived, it'll expire on its own.

### Multi-tab sign-out

1. Tab A: user clicks sign out → our flow runs → reload
2. Tab B: Better Auth broadcasts `"signout"` via BroadcastChannel → session refetch → anonymous → `onLogout` fires → `clearLocalData()` + `reload()`
3. Both tabs end up clean. The `onLogout` fallback handles Tab B.

### User offline with local changes

1. Sync status: `phase !== 'connected'` (offline)
2. Our check detects this → shows confirmation dialog: "You have unsynced changes that will be lost"
3. User can cancel (stay signed in) or confirm (accept data loss)
4. No silent data loss.

### Per-document IndexedDB databases

1. `clearLocalData()` only hits workspace-level persistence callbacks
2. Open sub-document Y.Docs (e.g., note bodies) may have their own IndexedDB databases that aren't cleared
3. After reload, the workspace table is empty (no rows pointing to documents), so orphaned databases are unreachable
4. This is a storage leak, not data loss or exposure. Acceptable for now.

## Success Criteria

- [ ] All 5 apps: `onLogout` does `clearLocalData()` then `reload()`, no more `reconnect()`
- [ ] 4 apps (excluding zhongwen): sign-out button checks sync status before proceeding
- [ ] 4 apps: unsynced changes show a destructive confirmation dialog before sign-out
- [ ] No TypeScript errors in changed files
- [ ] Page reload after sign-out eliminates in-memory ghost state

## References

- `packages/workspace/src/extensions/sync/websocket.ts`: `SyncStatus` type, `hasLocalChanges` field
- `packages/ui/src/confirmation-dialog/confirmation-dialog.svelte`: Shared confirmation dialog component
- `packages/svelte-utils/src/auth/create-auth.svelte.ts`: `signOut()` implementation, `onLogout` trigger
- `packages/workspace/src/workspace/create-workspace.ts`: `clearLocalData()` implementation
- `apps/fuji/src/lib/components/EntryEditor.svelte`: Example `confirmationDialog.open()` usage pattern to follow
