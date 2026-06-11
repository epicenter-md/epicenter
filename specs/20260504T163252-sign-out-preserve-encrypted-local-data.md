# Sign-out preserves encrypted local data

**Date**: 2026-05-04
**Status**: Superseded
**Superseded by**:
- `specs/20260504T233223-sign-out-preserves-local-data.md`: current product invariant ("sign-out destroys the live workspace and reloads; sign-in opens only the local cache scoped to that authenticated owner")
- `specs/20260505T020000-collapse-owner-scoping-onto-coordinator.md`: owner-scoped IDB names (`epicenter:v1:user:{userId}:yjs:{guid}`) make the explicit per-app `localStorage` owner marker proposed in this draft redundant; cross-user pollution is now impossible at the storage primitive level
- `specs/20260505T060000-zhongwen-context-and-listener-collapse.md`: per-app inline `auth.onChange` listener with three branches replaces the modified `bindAuthWorkspaceScope` (`applyAuthIdentity / leave / reset`) callback split this draft proposed
**Author**: AI-assisted
**Branch**: not started
**Related**:
- `specs/20260414T143000-safe-sign-out-flow.md`
- `specs/20260504T231540-attach-sync-trim-to-supervisor.md`
- `docs/encryption.md`
- `docs/articles/20260504T160541-asymmetric-wins-support-fewer-features-to-collapse-complexity.md`

## One-sentence test

Sign-out discards the auth session and in-memory workspace keys; encrypted
IndexedDB data stays on the device for the same user, and a different user gets
a local wipe before their keys or sync can touch the old document.

If this sentence holds, the safe-sign-out feature is the wrong product promise.
We do not need to ask whether unsynced changes are safe to delete because
ordinary sign-out no longer deletes them.

## Overview

The current sign-out flow treats local encrypted data as dangerous and wipes it
on logout or user switch. That made `AccountPopover` check `hasLocalChanges`
before calling `auth.signOut()`, which pulled a custom `SYNC_STATUS` protocol
extension into `attachSync`.

This spec replaces that promise. Local encrypted data is allowed to survive
ordinary sign-out. User switching remains destructive, but only after an owner
marker proves the local document belongs to another user. The asymmetric win is
large: a small product refusal deletes the safe-sign-out dialog, the only
consumer of `hasLocalChanges`, and the custom `SYNC_STATUS` wire path.

## Current state

Every synced browser app wires auth to workspace reset through
`bindAuthWorkspaceScope`:

```ts
bindAuthWorkspaceScope({
	auth,
	applyAuthIdentity(session) {
		workspace.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await workspace.wipe();
		} finally {
			window.location.reload();
		}
	},
});
```

`bindAuthWorkspaceScope` currently calls `resetLocalClient()` when identity
becomes `null`, and also when the applied user id changes:

```ts
if (identity === null) {
	if (appliedUserId === null) return;
	await reset();
	return;
}

if (appliedUserId !== null && appliedUserId !== userId) {
	await reset();
	return;
}
```

Because sign-out wipes IndexedDB, `AccountPopover` guards the button with sync
status:

```ts
const isSynced = current.phase === 'connected' && !current.hasLocalChanges;

if (isSynced) {
	doSignOut();
} else {
	confirmationDialog.open({
		title: 'Sign out with unsynced changes?',
		description:
			"Some changes haven't synced to the cloud yet. Signing out will lose them.",
		onConfirm: doSignOut,
	});
}
```

That one UI promise forces a wide implementation family:

```txt
AccountPopover safe-sign-out branch
ConfirmationDialog mounts in app layouts
SyncStatus.connected.hasLocalChanges
attach-sync localVersion and ackedVersion counters
debounced SYNC_STATUS client messages
SYNC_STATUS echo in apps/api/src/sync-handlers.ts
MESSAGE_TYPE.SYNC_STATUS plus encode/decode helpers in @epicenter/sync
tests and docs for "Saving" versus "Saved"
```

## Research findings

### y-indexeddb stores by document name, not user

The Yjs docs say `new IndexeddbPersistence(docName, ydoc)` uses `docName` as
the unique string identifying the persisted document, and `clearData()` destroys
that database. Our wrapper passes `ydoc.guid`:

```ts
export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	return {
		whenLoaded: idb.whenSynced,
		clearLocal: () => clearDocument(ydoc.guid),
		whenDisposed,
	};
}
```

Current app workspace ids are fixed strings:

```ts
new Y.Doc({ guid: 'epicenter.fuji', gc: false });
new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
new Y.Doc({ guid: 'epicenter.opensidian', gc: false });
new Y.Doc({ guid: 'epicenter.tab-manager', gc: false });
```

Implication: IndexedDB does not create a separate local database per auth user.
If we stop wiping on sign-out, user separation must be enforced by our lifecycle
binding, not by `y-indexeddb`.

Reference: [Yjs y-indexeddb docs](https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb).

### Yjs stores encrypted values as opaque binary application data

Yjs shared arrays accept `Uint8Array` values, and document updates are binary
CRDT updates that can be applied in any order until clients converge. Yjs does
not know whether a `Uint8Array` is an encrypted blob or an image chunk. It stores
and syncs the bytes as application content.

Epicenter uses that property deliberately:

```txt
set(key, value)
  -> JSON.stringify(value)
  -> encryptValue(json, workspaceKey, aad = keyBytes, keyVersion)
  -> inner.set(key, encryptedBlob)
```

Implication: encrypted values are safe from plaintext reads without the right
key, but the CRDT skeleton is not hidden. Table names, row ids, value keys, and
timestamps remain visible to code that directly inspects the Y.Doc.

References:
- [Y.Array supports `Uint8Array`](https://docs.yjs.dev/api/shared-types/y.array)
- [Yjs document updates](https://docs.yjs.dev/api/document-updates)

### Epicenter keys are user-scoped, then workspace-scoped

The API attaches encryption keys to the Better Auth session:

```ts
const customSessionPlugin = customSession(async ({ user, session }) => {
	const encryptionKeys = await deriveUserEncryptionKeys(user.id);
	return { user, session, encryptionKeys };
});
```

The encryption package derives a per-user key from deployment secrets and user
id, then the workspace layer derives a per-workspace key from that user key and
`ydoc.guid`:

```ts
deriveUserEncryptionKeys({ secrets, userId });
deriveWorkspaceKey(userKey, workspaceId);
```

Implication: user B cannot decrypt user A's encrypted values just because the
workspace id is the same. The user id is in the key derivation path.

This is not zero-knowledge encryption. `docs/encryption.md` is clear that the
deployment owning `ENCRYPTION_SECRETS` is inside the trust boundary. The relevant
property here is local user separation: different auth users get different
derived workspace keys.

### The encrypted wrapper skips unreadable entries

`createEncryptedYkvLww` does not keep a plaintext cache. Reads decrypt from the
inner store each time:

```ts
get(key): T | undefined {
	const stored = inner.get(key);
	if (stored === undefined) return undefined;
	return decrypt(stored, textEncoder.encode(key));
}
```

When a blob cannot decrypt, `get()` returns `undefined`, `entries()` skips it,
and observers log then continue. The inner LWW store still contains the entry,
so unreadable old data can affect storage size and timestamp baselines. A later
write to the same key replaces it, but unrelated row ids remain orphaned.

Implication: encryption protects values, not the local document from pollution.
For a different user, preserving old blobs side by side is technically
possible, but it is the wrong product choice.

### The remote sync room is already user-scoped

`apps/api/src/app.ts` builds Durable Object names with the authenticated user id:

```ts
const doName = `user:${c.var.user.id}:workspace:${c.req.param('workspace')}`;
```

The server is safe from cross-user remote merging. The risky path is local:
if user B signs into a browser that still has user A's local Y.Doc under the
same `ydoc.guid`, the client could sync user A's unreadable ciphertext into user
B's otherwise clean remote room unless we wipe before applying B's identity.

Implication: "just leave unreadable blobs forever" is too loose. Same-user
preservation is good. Different-user preservation is not.

### Better Auth sign-out is an auth operation

Better Auth documents client `signOut()` as the way to sign out and optionally
run a redirect on success. It does not know about Epicenter workspace IndexedDB
databases. Our `@epicenter/auth` wrapper clears the local auth credential and
emits `identity = null`; workspace cleanup is our binding's responsibility.

Reference: [Better Auth basic usage](https://better-auth.com/docs/basic-usage).

### Bitwarden is the useful analogy, with a different trust boundary

Bitwarden separates login from unlock. Its docs describe encrypted vault data on
disk and decrypted keys/data in memory after unlock. Locking deletes decrypted
vault data and the decrypted account encryption key from memory.

The useful analogy is the product invariant, not the exact crypto model:
encrypted local data may remain on disk, while sign-out or lock removes the
credentials needed to read it.

Epicenter is not Bitwarden. The API can derive user keys from deployment
secrets. Still, the local invariant is valid: sign-out should remove the auth
session and in-memory keys, not necessarily destroy encrypted local bytes.

References:
- [Bitwarden: log in vs unlock](https://bitwarden.com/help/understand-log-in-vs-unlock/)
- [Bitwarden cryptographic architecture](https://bitwarden-clients.mintlify.app/guide/cryptography)

## Direct answers

### Where are the blobs stored?

Root workspace blobs live in the `y-indexeddb` database named by `ydoc.guid`.
For Fuji that is `epicenter.fuji`; for Honeycrisp it is
`epicenter.honeycrisp`; for Opensidian it is `epicenter.opensidian`; for Tab
Manager it is `epicenter.tab-manager`.

Child document blobs use their own document guid, for example:

```ts
docGuid({
	workspaceId: doc.ydoc.guid,
	collection: 'entries',
	rowId: entryId,
	field: 'content',
});
```

`wipe()` currently clears the root database and each known child database.
If child rows are unreadable, their child doc names may not be discoverable from
the decrypted table layer, so a future "forget this device" operation should
prefer a manifest or prefix-based database inventory instead of relying only on
decryptable rows.

### If the same user signs in again, what should happen?

Same user should keep the local encrypted data. On the next sign-in, the app
receives that user's encryption keys, derives the same workspace key for the
same `ydoc.guid`, and decrypts the local blobs. Offline changes then sync to the
same user's remote DO.

This is the behavior we want. It is the whole reason ordinary sign-out should
stop wiping IndexedDB.

### If a different user signs in on the same machine, what should happen?

Different user should not inherit the old local document. They cannot decrypt
the old values, but leaving the old Y.Doc in place has bad side effects:

```txt
old user A local Y.Doc
  -> user B signs in
  -> same ydoc.guid opens
  -> user B cannot decrypt A values
  -> but old row ids and timestamps remain in the local CRDT
  -> sync could upload A ciphertext into B's user-scoped remote room
```

Decision: wipe on owner mismatch before applying the new identity. Do not allow
side-by-side encrypted documents for multiple users under one `ydoc.guid`.

### Can signed-out UI read local data at rest?

Through the encrypted workspace API, encrypted values read as `undefined` until
keys are applied. That is good, but it is not enough as the only defense.

The new invariant should also require apps to treat workspace data UI as
auth-gated. Signed-out UI can show auth and device controls. It should not render
tables, notes, tabs, files, or settings from a workspace whose owner is only
known through encrypted local state.

Plaintext migration is the reason for this extra guard. The encrypted wrapper
passes plaintext values through when no key is active. Activation encrypts
plaintext entries, but a signed-out cold boot before activation should not rely
on "there should be no plaintext left" as a UI boundary.

## Asymmetric wins pass

Product sentence:

```txt
Sign-out removes credentials and in-memory keys. Local encrypted data survives
for the same user and is wiped before a different user can use the workspace.
```

Candidate refusal:

```txt
Sign-out refuses to be a destructive local-data operation, so it also refuses to
promise a "safe sign-out" check based on cloud acknowledgement.
```

Code family it deletes:

```txt
AccountPopover unsynced confirmation branch
ConfirmationDialog mounts used only for sign-out
connected.hasLocalChanges UI dependency
attach-sync localVersion and ackedVersion counters
SYNC_STATUS debounce timer
SYNC_STATUS client decode branch
SYNC_STATUS server echo
MESSAGE_TYPE.SYNC_STATUS
encodeSyncStatus and decodeSyncStatus
tests for the custom saved/saving protocol
the older safe-sign-out spec as an active product direction
```

User loss:

```txt
Signing out no longer offers "clear this device" semantics.
Encrypted local data can remain on disk until the same user returns, another
user signs in and triggers mismatch wipe, or a future explicit forget action is
added.
```

Decision:

```txt
Refuse destructive ordinary sign-out. The lost behavior is a device-cleanup
convenience. The deleted implementation graph is a custom sync protocol and a
cross-app destructive UX flow.
```

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Ordinary sign-out | Design coherence | Preserve IndexedDB | The product sentence says sign-out removes credentials, not encrypted bytes. |
| User switch | Design coherence | Wipe before applying new identity | Different-user side-by-side data would pollute the new user's local and remote documents. |
| Owner tracking | Evidence plus design | Persist a local owner marker per workspace id | `y-indexeddb` is keyed by document name only, so the app must remember who owns that local document. |
| Owner mismatch timing | Design coherence | Reset before `applyAuthIdentity()` and before sync reconnect can use the new credential | Prevents old ciphertext from being uploaded into the new user's DO. |
| Same-user return | Design coherence | Apply keys and keep local data | This is the value of the whole change. Offline work survives sign-out. |
| Signed-out data UI | Design coherence | Auth-gate workspace data views | Encrypted reads are skipped without keys, but plaintext migration makes UI gating the cleaner boundary. |
| Per-user local databases | Taste under constraints | Do not adopt now | User-scoped `ydoc.guid` would force auth-gated workspace construction across app singletons. Owner mismatch wipe is smaller and keeps current app shape. |
| Explicit "forget this device" | Taste under constraints | Defer | It is a useful future command, but adding it now would keep destructive sign-out alive under another name. |
| `SYNC_STATUS` | Design coherence | Remove after the popover no longer reads it | No remaining product sentence needs server-acknowledged local-change status. |

## Target architecture

### Stored owner marker

Each app stores one owner marker per root workspace id:

```txt
key: epicenter.workspace-owner:<workspaceId>
value: <auth user id>
```

For browser apps this can be `localStorage`. For the Chrome extension it can be
loaded from WXT storage before binding and then exposed through a synchronous
in-memory adapter. The binding should not start from an unresolved owner read.

The marker is not a secret. It only answers this question:

```txt
Does this local IndexedDB document belong to the identity that is about to get
workspace keys and network sync?
```

### Auth lifecycle

```txt
BOOT, SIGNED IN
  read owner marker
  if owner is null:
    set owner to current user id
    apply encryption keys
  if owner equals current user id:
    apply encryption keys
  if owner differs:
    wipe local workspace data
    clear owner marker
    reload

SIGN OUT
  auth.signOut clears credential
  binding sees identity null
  reload without wiping IndexedDB
  owner marker remains
  encrypted local data remains

SAME USER SIGNS IN AGAIN
  owner marker matches
  apply encryption keys
  local encrypted data becomes readable
  sync sends offline changes to same user's DO

DIFFERENT USER SIGNS IN
  owner marker differs
  wipe local data before applying keys
  clear owner marker
  reload
  next boot sets owner to new user and starts clean
```

### Why reload still matters

`createEncryptedYkvLww` has no `deactivateEncryption()` path. After keys are
applied, they remain in wrapper memory until the workspace is destroyed. A page
reload is still the simplest way to make sign-out discard in-memory keys, Svelte
state, live Y.Doc contents, BroadcastChannel state, WebSocket state, and pending
RPC callbacks.

The change is not "do nothing on sign-out." The change is:

```txt
before: sign-out -> wipe disk -> reload
after:  sign-out -> keep encrypted disk -> reload
```

## Implementation plan

### Phase 0: Re-verify the current graph

- [ ] **0.1** Grep all apps and packages for `hasLocalChanges`,
  `SYNC_STATUS`, `encodeSyncStatus`, `decodeSyncStatus`, and sign-out
  confirmation copy.
- [ ] **0.2** Confirm `AccountPopover` is the only real product consumer of
  `connected.hasLocalChanges`.
- [ ] **0.3** Confirm every synced browser app has a root workspace id and a
  `wipe()` implementation that destroys the doc before awaiting IndexedDB
  deletion.
- [ ] **0.4** Confirm child document wipe can still enumerate child document
  ids from the root table before destroying the doc. If not, document the gap
  for a later "forget this device" operation.

### Phase 1: Add owner marker without changing sign-out behavior

- [ ] **1.1** Add a small owner marker helper, probably in
  `packages/auth-workspace`, with browser and extension adapters supplied by
  apps.
- [ ] **1.2** On every successful `applyAuthIdentity(identity)`, store
  `identity.user.id` for the root workspace id if no owner exists.
- [ ] **1.3** If an owner exists and differs from the incoming identity, call
  the existing destructive reset path.
- [ ] **1.4** Keep current sign-out wipe for this phase. This makes the rollout
  safe because signed-in users get markers before sign-out preservation lands.
- [ ] **1.5** Add tests for cold signed-in, same-user refresh, and owner
  mismatch.

### Phase 2: Split leave from reset

- [ ] **2.1** Change `bindAuthWorkspaceScope` so `identity === null` calls a
  new non-destructive leave callback instead of `resetLocalClient()`.
- [ ] **2.2** Keep `resetLocalClient()` for owner mismatch and explicit future
  device cleanup only.
- [ ] **2.3** App leave callbacks should reload without calling `workspace.wipe()`.
- [ ] **2.4** Owner mismatch callbacks should call `workspace.wipe()`, clear the
  owner marker, and reload.
- [ ] **2.5** Add tests proving sign-out does not call wipe, user mismatch does
  call wipe, and a queued different identity is not applied before reset.

### Phase 3: Collapse AccountPopover

- [ ] **3.1** Remove the safe-sign-out branch from
  `packages/svelte-utils/src/account-popover/account-popover.svelte`.
- [ ] **3.2** Remove the `confirmationDialog` import from `AccountPopover`.
- [ ] **3.3** Remove app-level `<ConfirmationDialog />` mounts that exist only
  for sign-out. Keep mounts used by unrelated destructive actions.
- [ ] **3.4** Update popover JSDoc: sign-out signs out and the lifecycle binding
  reloads to clear in-memory keys.
- [ ] **3.5** Re-check signed-out workspace views. Any app that renders
  workspace data while signed out should gate that view behind `auth.identity`.

### Phase 4: Remove `SYNC_STATUS` and `hasLocalChanges`

- [ ] **4.1** Remove `hasLocalChanges` from `SyncStatus`.
- [ ] **4.2** Remove `localVersion`, `ackedVersion`, and `syncStatusTimer` from
  `packages/workspace/src/document/attach-sync.ts`.
- [ ] **4.3** Remove the `MESSAGE_TYPE.SYNC_STATUS` branch from client and
  server handlers.
- [ ] **4.4** Remove `MESSAGE_TYPE.SYNC_STATUS`, `encodeSyncStatus`, and
  `decodeSyncStatus` from `packages/sync/src/protocol.ts`.
- [ ] **4.5** Update tests and CLI fixtures that still construct
  `{ phase: 'connected', hasLocalChanges: false }`.
- [ ] **4.6** Amend `specs/20260504T231540-attach-sync-trim-to-supervisor.md`
  or mark its Cut #2 as superseded by this spec's lifecycle decision.

### Phase 5: Verify behavior

- [ ] **5.1** Run focused package tests:
  `bun test packages/auth-workspace packages/workspace packages/sync packages/svelte-utils apps/api`.
- [ ] **5.2** Run the relevant app typechecks through the monorepo scripts.
- [ ] **5.3** Manual same-user smoke:
  sign in, edit offline, sign out, sign in as the same user, verify local edits
  return and sync.
- [ ] **5.4** Manual different-user smoke:
  sign in as A, create data, sign out, sign in as B, verify local wipe happens
  before B sees workspace data or syncs.
- [ ] **5.5** Inspect IndexedDB after same-user sign-out. The root database
  should remain. Inspect after different-user sign-in. The old database should
  be removed before B starts clean.

## Edge cases

### Owner marker missing

If the owner marker is missing on a signed-in boot, set it to the current user
and apply keys. This is safe during the intended rollout because Phase 1 writes
markers before Phase 2 preserves data on sign-out.

If we discover real signed-out devices with unmarked IndexedDB data, use a
one-time conservative migration: when identity appears and owner is missing, but
the app can prove local encrypted rows already exist from a prior user, wipe and
reload instead of adopting the data. Do not guess silently.

### Owner marker corrupt

Treat a malformed owner marker as mismatch. Wipe local data, clear the marker,
and reload. A corrupt marker should not let old local data attach to a new user.

### Sign-out fails

If `auth.signOut()` returns an error, keep the user signed in and do not reload.
No local data policy should run until auth actually emits `identity = null`.

### Session expires remotely

Remote session expiry also emits `identity = null`. It should follow the same
non-destructive leave path: reload to drop keys, keep encrypted local data, keep
the owner marker.

### Multi-tab sign-out

One tab signs out and reloads. Other tabs receive auth state changes and reload
without wiping. IndexedDB remains for the same owner. BroadcastChannel and
WebSocket state die with the reload.

### Different-user sign-in race

The owner mismatch reset must synchronously destroy the workspace doc before any
await that could let `attachSync` reconnect with the new credential. Existing
`wipe()` methods already start with `doc[Symbol.dispose]()` before awaiting
`whenDisposed` and `clearLocal()`. Keep that property load-bearing and test it.

### Child document leaks

Same-user sign-out intentionally keeps child document databases. Different-user
wipe should delete all child documents that the root table can enumerate before
destroy. If unreadable root rows prevent enumeration, the old child databases
can become orphaned storage. That is acceptable for this spec because the root
owner mismatch wipe still prevents the new user from reading them through the
workspace, but a future "forget this device" command should use a database
manifest so it can wipe orphaned child docs too.

## Success criteria

- [ ] Ordinary sign-out never calls `workspace.wipe()`.
- [ ] Ordinary sign-out reloads or otherwise destroys the in-memory workspace
  scope so encryption keys are gone.
- [ ] Same-user sign-in after sign-out reuses local encrypted IndexedDB data.
- [ ] Different-user sign-in wipes local workspace data before applying keys or
  syncing.
- [ ] `AccountPopover` has no unsynced-change confirmation branch.
- [ ] No UI reads `connected.hasLocalChanges`.
- [ ] `MESSAGE_TYPE.SYNC_STATUS` and its encode/decode helpers are gone.
- [ ] `attach-sync.ts` no longer tracks local acked versions for sign-out UX.

## Decisions log

- Keep fixed root `ydoc.guid` values for now. Revisit when auth-gated dynamic
  workspace construction becomes desirable for another reason.
- Defer explicit "forget this device." Revisit after ordinary sign-out no longer
  owns destructive cleanup and users ask for device cleanup as its own command.
- Accept orphaned encrypted child document storage after unusual mismatch cases.
  Revisit when adding a persisted child document manifest.

## References

- `packages/auth-workspace/src/index.ts`
- `packages/svelte-utils/src/account-popover/account-popover.svelte`
- `packages/workspace/src/document/attach-indexed-db.ts`
- `packages/workspace/src/document/attach-encryption.ts`
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`
- `packages/workspace/src/document/attach-sync.ts`
- `packages/sync/src/protocol.ts`
- `apps/api/src/app.ts`
- `apps/api/src/sync-handlers.ts`
- `docs/encryption.md`
