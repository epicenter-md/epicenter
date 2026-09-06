# 0351. Local data removal is an explicit sign-out choice

- **Status:** Proposed
- **Date:** 2026-09-05
- **Unbuilt:** an application exit coordinator with two sign-out actions, durable interrupted-removal recovery, and complete account-scoped removal across supported runtimes.

## Context

`AccountPopover` in `packages/app-shell/src/account-popover/account-popover.svelte`
calls `auth.signOut()` directly. Its separate `onForgetDevice` callback erases
local data and reloads without signing out. Honeycrisp and Vocab supply that
callback; Whispering withholds it because its audio has no principal-scoped
removal path.

`eraseReplica` in `packages/app/src/index.ts` closes the store and reopens on
failure. `eraseGenerations` in `packages/data/src/store/browser.ts` deletes
databases sequentially. A failure can therefore follow a successful deletion.
Reopening is not rollback and can download data the person was removing.

Local persistence and network authorization already have separate owners.
`packages/data/src/store/persistence.ts` records saved updates and authority
acknowledgments. Credential refusal does not invalidate that local document.

## Decision

**The account menu offers “Sign out” and “Sign out and remove local data.”**

The first action retains persisted account data. The second removes this
application's managed local data for the selected account. In the confirmation,
name the application and state that unsynced changes and local-only recordings
can be the only copies. Say that online data and exported files remain.
Do not call the local working copy a cache.

**Credential expiry preserves local work.**

Automatic refresh runs through auth. When human action is required, an already
open account continues editing and persisting. A successful connection for the
same authority and principal resumes delivery of durable updates. A different
identity gets a different session. “Saved on this device” requires confirmed
local persistence; a live document in memory is insufficient. Reauthentication
that navigates away needs the same local-save protection as ordinary sign-out.

**One application exit coordinator owns the complete operation.**

The coordinator is the proposed owner above auth and the data session, with
runtime-specific storage operations below it. Account-menu callers submit an
intent and render its result. Auth continues owning credential deletion and
best-effort remote token revocation; it acquires no application-storage knowledge.

For ordinary sign-out, the coordinator prevents new account work, settles active
operations, confirms local saves, closes account resources, and clears local
credentials. A failed save leaves recoverable memory alive and offers retry.
It cannot silently discard that work or report successful sign-out.
Explicit closure reaches cooperating contexts in this app's browser
origin/profile or desktop installation. It cannot rely on eventual server
rejection: that event intentionally preserves local editing. Suspended contexts
must observe a durable closure boundary before resuming work, and late refresh
results must not restore a cleared grant. Activity can be disabled immediately;
completion and navigation wait for durable credential clearing.

For destructive sign-out, confirmation authorizes discarding unsaved work as
well as unsynced persisted work. The coordinator captures the target identity,
durably records removal intent, excludes account writers and openers, closes
resources, removes managed local data, and clears credentials. It clears the
intent only after both removal and credential clearing succeed. Deletion does
not wait for an upload and never purges online data.

**An interrupted removal stays closed until recovery completes.**

The removal intent survives reload and sits outside the data it removes. Every
account opener checks it before hydration, sync, recording, or materialization.
Removal and credential clearing are idempotent. Retry retains the captured
target even after sign-out. Partial success does not reopen the account or
restore deleted data. A failure screen outside the session reports which part
remains incomplete without displaying account content.
An IndexedDB deletion blocked by another connection remains pending even if a
wrapper reports an error. Exclusion stays in force until pending work settles;
the operation must not interpret a rejection as cancellation.

**Removal requires exclusive access to this app's account-owned resources.**

An app/principal exclusion boundary covers all generations, blobs, temporary
recordings, derived private data, and managed projections. All cooperating tabs,
windows, and native writers obey it. A busy owner may block removal with a
concrete instruction to close the other window; unattended forced shutdown is
not required. A one-time broadcast or a list of current databases is not an
exclusion boundary because new writers could start afterwards.

Device preferences remain. User-chosen exports and external working folders
remain, and the confirmation says so. SQLite and secrets are classified by
contents and owner, not their storage format. Older or unscoped data whose
ownership cannot be established must not be silently swept or hidden behind a
claim that all account data was removed.

## Consequences

The product retains offline work without making ordinary sign-out destructive.
The destructive action adds one persistent recovery record and an exclusion
boundary that every account writer must honor. Removing documents and audio
across different stores is a resumable operation, not an atomic transaction.

Retained data is not protected from someone controlling the same OS or browser
profile. Removal means application-level deletion, not forensic erasure. Neither
action promises to revoke an already downloaded offline copy on another device.

Automatic audio upload is independent work. The removal warning includes local
audio under the current explicit-upload policy; a synchronized document is not
proof that its referenced audio is online.

## Considered alternatives

- Delete on credential expiry: involuntary network failures destroy local work.
- Delete on every explicit sign-out: every exit must confront sole-copy loss.
- Reopen after any deletion failure: sequential deletion may already have
  removed part of the account, and sync can recreate removed data.
- Wait for all uploads before removal: a person cannot remove data while offline.
- Add encryption to make sign-out lock retained data: requires a separate key,
  unlock, and recovery design beyond this removal contract.
