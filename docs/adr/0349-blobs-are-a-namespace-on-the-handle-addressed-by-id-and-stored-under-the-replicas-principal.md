# 0349. Blobs are a namespace on the handle, addressed by id, and stored under the replica's principal

- **Status:** Proposed
- **Date:** 2026-09-05
- **Supersedes:** [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md) at its public operations, `table.blobUrl(rowId)` and `table.writeBlob(rowId, bytes)`. Neither exists and neither will: a blob is addressed by `BlobId`, not by the row that cites it. ADR-0173 is `Proposed` and its write-once slot was already withdrawn by [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md), so what is left of it after this record is a `Considered alternatives` entry.
- **Amends:** [ADR-0205](0205-a-recording-is-a-row-that-fills-and-a-crash-finishes-it-rather-than-losing-it.md) at "No blob identity crosses the boundary, ever. There is no `BlobId`", which is withdrawn: the recorder returns the id at `stop` and the application writes it into the row, which `apps/whispering/src/lib/whispering/recording-audio.ts` already does through `recording.audioBlobId`. Its row-that-fills rule and its refusal of a recorder-owned `cancel` stand. And [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) at the spelling of `apps/<app-id>/blobs/`, which gains a `<principal-id>` segment; its one directory per app and its refusal of a shared root stand. And [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) at its open question of who tells the recorder where blobs live, which is answered below: the caller hands `start` the app and the principal.
- **Relates:** [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md) (a minted nanoid, never a content hash), [ADR-0154](0154-blob-access-is-address-only.md) (address-only, no enumeration), [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (audio does not move into the page), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md), [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) (`principals/<id>/blobs/<blobId>`, per principal and not per generation), [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md) ("a blob reference travels; the blob bytes do not"), [ADR-0348](0348-the-local-address-carries-the-principal-and-a-database-needs-no-binding-to-know-whose-it-is.md) (the principal is an address segment), [ADR-0342](0342-sign-in-is-the-door-to-keeping-not-to-using.md) (`Proposed`, edited in place: a trial has no blob store for the same reason it has no replica), [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md) (`Superseded` by [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md); its `upload`/`download`/`purge` vocabulary survives here)
- **Amended by:** [ADR-0352](0352-an-account-s-data-and-a-device-s-files-are-two-packages-because-only-one-of-them-is-removed.md) at its composition: `EpicenterBinding` is deleted, so blobs cannot join it. The principal-scoped address and the `BlobId` grammar stand.
- **Unbuilt:** all of it except one deletion. The unused document-bytes `Blobs` contract (`packages/data/src/store/blobs.ts`, `blobs.opfs.ts`, `test-opfs.ts`, `blobs.test.ts`, and the `./blobs`, `./blobs/opfs`, `./test-opfs` exports) is gone, which ends the name collision. Everything else stands: there is no `blobs` member on `Epicenter` or on `EpicenterBinding`; the browser store still opens the device-global IndexedDB name `epicenter-blobs` (`packages/blobs/src/browser.ts:15`); `recorder/blob.rs` still resolves `<appDataDir>/blobs` from the app handle rather than taking a scope at `start`; `eraseGenerations` deletes generations and no blob store; and `RemoteUnavailable`, `epicenter.blobs.url`, and the automatic-upload policy do not exist.

## Context

Blobs today are Whispering's, not the platform's. `apps/whispering/src/lib/services/blobs/index.browser.ts` composes `createBrowserBlobStore()` with a remote built from `authClient`, exports them as `BlobsLive: { local, remote: BlobRemote | null }`, and `apps/whispering/src/lib/services/index.ts` puts that on `services.blobs` beside `services.blobSources`. Every other application that wants bytes copies that file.

The composition it copies has three faults. `remote` is `null` while signed out, so a caller reads a nullable property to learn an auth fact and then invents its own refusal; `recording-audio.ts` has a `requireRemote` helper that exists only to turn the null into an error. The `local`/`remote` nesting groups by implementation rather than by what a caller wants, so five of the eight verbs are one level deeper than they need to be to buy that one null check. And `createBrowserBlobStore()` opens `epicenter-blobs`, one database for the whole origin: two accounts on one browser profile share every byte, which is exactly the failure ADR-0348 just removed from the data address.

There is a second, unrelated thing called blobs in the tree. `packages/data/src/store/blobs.ts` and `blobs.opfs.ts` define a `Blobs` contract over document bytes, reachable at the `@epicenter/data/blobs` and `@epicenter/data/blobs/opfs` exports, with `keySegments`, `createOpfsBlobs`, and a `test-opfs.ts` harness. No production module imports it; its only callers are its own test and ADR-0342's sentence about a trial. Two contracts named `Blobs`, one of which nothing uses, is the reason a reader has to check which one a file means.

## Decision

**Blobs are one namespace on the `createEpicenter` handle, present only on the half that has an account.**

```ts
epicenter.blobs: {
  put(blob: Blob):      Promise<Result<BlobId, BlobStoreFailed>>;
  get(id: BlobId):      Promise<Result<Blob, BlobNotFound | BlobStoreFailed>>;
  stat(id: BlobId):     Promise<Result<{ size: number; contentType: string }, BlobNotFound | BlobStoreFailed>>;
  url(id: BlobId):      Promise<Result<BlobSource, BlobNotFound | BlobStoreFailed>>;
  delete(id: BlobId):   Promise<Result<void, BlobStoreFailed>>;
  upload(id: BlobId):   Promise<Result<void, BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RemoteUnavailable>>;
  download(id: BlobId): Promise<Result<void, RemoteBlobNotFound | BlobStoreFailed | BlobRemoteFailed | RemoteUnavailable>>;
  purge(id: BlobId):    Promise<Result<void, BlobRemoteFailed | RemoteUnavailable>>;
}
```

`put`, `get`, `stat`, `url`, and `delete` act on this device. `upload`, `download`, and `purge` act on the authority. The split is in the error set rather than in a second object: the three authority verbs are the three that can answer `RemoteUnavailable`. It sits beside `account`, `state`, and `open` and not beside `sqlite` and `secrets`, because a blob key is `principals/<id>/blobs/<blobId>` and an account is what names the principal, the same reason `open` is there (ADR-0336).

**There is no `list`,** which is ADR-0154 unchanged: the application's own rows are the inventory, and a blob whose every citing row is gone is unreachable.

**`RemoteUnavailable` is a typed error, not a null capability.** A signed-out account reaches `upload` and is refused by name, the way sync degrades rather than disappearing. `BlobRemote | null` and the `requireRemote` helper that reads it are deleted.

**`url` returns a `BlobSource`, which is `Disposable & { url }`** (`packages/blobs/src/blob-source.ts`). In a browser the only URL over IndexedDB bytes is an object URL, and an object URL that is never revoked is a leak the page cannot see; on desktop the host serves a stable same-origin route and the disposer is a no-op. Callers release unconditionally.

**A row records whether its blob is uploaded; the blob store does not.** Whispering's `uploadedAt` is the instance: `availability` in `recording-audio.ts` reads `stat` for local bytes and the row's `uploadedAt` for the remote copy, and the four states it returns come from the pair. `stat` answers size and content type about this device and nothing about the authority.

**Bytes live in one grammar with two substrates, scoped by app and principal, beside the data id.**

```txt
browser   epicenter/v5/<app-id>/<principal-id>/blobs                (one IndexedDB database)
desktop   <root>/apps/<app-id>/<principal-id>/blobs/<blob-id>/      (host filesystem)
```

The browser name is the sibling of `epicenter/v5/<app-id>/<principal-id>/<data-id>/<n>` (ADR-0348). The principal is in the path for erasure and confidentiality rather than for ADR-0348's merge argument: two `blob_` nanoids cannot collide, but `eraseReplica` has to be able to take one account's audio and leave another's, and a second person signing in on a shared laptop must not reach the first one's recordings. It is scoped by principal rather than by data id because the authority is scoped by principal, and rows in two of one app's data ids may cite one `BlobId`.

**`sqlite` and `secrets` are not split by principal, and this record says so because ADR-0348 reads as if it covers the whole handle.** An app-owned file is a device cache opened before sign-in (ADR-0306, ADR-0321), and a keychain entry is how an account is reached at all, so neither has a principal to be scoped by. The trigger for adding the segment is the first application that both opens a store and opens a file or a secret with account-specific contents; until then the address stays `apps/<app-id>/sqlite/<name>.sqlite` and `app:<app-id>:<label>`.

**Desktop bytes stay on the host filesystem.** ADR-0226 refuses moving them into the page and states the price: the Rust progressive writer needs a filesystem, multi-hour captures do not belong in IndexedDB, and an upload streams from the host instead of crossing WebView IPC. `apps/epicenter/src-tauri/src/recorder/blob.rs` resolves `blobs_directory` from the `AppHandle` and publishes to `<appDataDir>/blobs/<BlobId>`. It instead takes `{ appId, principalId }` at `start` and joins them, which is the answer to ADR-0201's open question about who tells the recorder where blobs live.

**The browser codec keeps storing `ArrayBuffer` plus content type.** WebKit rejects persisted `Blob` and `File` values (`packages/blobs/README.md`), so the store reconstructs a `Blob` on read. That stays until `bun run smoke:webkit` in `packages/blobs` proves otherwise.

**Erasing an account's replica erases its blobs.** `eraseReplica` deletes the blobs database or directory for that app and principal alongside the generations. It is a second explicit delete rather than a widened filter: `heldGenerationNames` in `packages/data/src/store/browser.ts` matches names under the prefix whose remainder is `/^[1-9][0-9]*$/`, and `blobs` is not a generation number. `eraseReplica` never purges the authority's copy.

**Amended by [ADR-0352](0352-an-account-s-data-and-a-device-s-files-are-two-packages-because-only-one-of-them-is-removed.md): there is no `EpicenterBinding` to gain a member.** The paragraph below is withdrawn at its mechanism and kept for its reasoning. Blob bytes are scoped by app and principal, which puts them on the account's side of ADR-0352's split and makes them the exit coordinator's business; where the bytes physically sit varies by runtime, which is the application's own `#platform/blobs` seam, and Whispering already has one. What is unresolved is which object carries the verbs, and this record no longer answers it.

**Composition lives in `@epicenter/app`, beside `openReplica`.** `packages/app/src/client-owned-data.ts` is where an address and an account already meet, and `upload` needs `account.fetch`. `EpicenterBinding` gains a `blobs` member, satisfied by `packages/app/src/browser.ts` and `packages/app/src/desktop.ts`, which is the seam `sqlite` and `secrets` already use. `@epicenter/blobs` stays as contracts plus adapters, the way `@epicenter/sqlite` does: `apps/epicenter/src/main.ts` uses `createBunBlobStore` without `@epicenter/app`.

**Deleted, in the same change.** Whispering's `#platform/blobs` seam and both leaves; `services.blobs` and `services.blobSources`; `createBrowserBlobRemote` and `createBunBlobRemote` in `packages/client/src/index.ts`; the `epicenter-blobs` database name. And the unused document-bytes contract: `packages/data/src/store/blobs.ts`, `blobs.opfs.ts`, `test-opfs.ts`, `blobs.test.ts`, and the `./blobs` and `./blobs/opfs` exports in `packages/data/package.json`, which `specs/20260828T230000-the-switch.md` step 9 already schedules. That ends the collision between `Blobs` (document bytes) and blobs (a person's files).

**Automatic upload is an application policy, not a surface.** An app that wants every blob kept calls `upload` after `put` from inside `open()` while signed in, beside sync. Nothing in the namespace above changes to allow it, and nothing is built for it here.

## Consequences

- **A second application gets blobs by reading one type instead of copying one file.** The composition Whispering owns today is roughly 40 lines it wrote and every next app would fork.
- **The verbs are the ones the callers already type.** `put` is the verb `secrets.put` uses on the same handle, and `upload`, `download`, and `purge` are what `recording-audio.ts` calls on `remote` at five sites. A caller migrating changes `services.blobs.local.stat(id)` to `epicenter.blobs.stat(id)` and `remote.upload(id)` to `epicenter.blobs.upload(id)`, and deletes `requireRemote`.
- **Every blob on every shipped device is stranded, silently, exactly as ADR-0348's `v4` records are.** `epicenter-blobs` is not reachable under the new name, and there is no reaper. On a device whose rows have `uploadedAt` set, `download` refetches; on one whose rows do not, the audio is in the origin's quota and nothing points at it. The bytes are recoverable by hand if a report arrives.
- **A blob orphaned by `eraseReplica` is unreachable from every device, forever.** Address-only means the citing row was the only index. This is the gap ADR-0325 already accepts for re-homing, and the backstop is the authority's account-deletion sweep, which ADR-0154 preserves as a deployment operation rather than a public route.
- **`RemoteUnavailable` costs every caller of the three authority verbs one more arm** in a `switch` on `error.name`. It buys the deletion of a nullable capability that a caller could read without ever handling.
- **The host's local-blob routes gain the principal segment and a scoped delete.** `/api/local-blobs/*` in `apps/epicenter/src/server.ts` gates on a browser session, not on a principal, and reads one flat directory. Under this layout the route resolves `<root>/apps/<app-id>/<principal-id>/blobs/<blob-id>/` from the caller's app and signed-in principal, and `eraseReplica` on desktop deletes that directory through it.
- **The recorder's signature changes and its tests change with it.** `start` takes two more strings, and `blobs_directory` stops reading the platform default it currently resolves natively.
- **A blob still cannot be shared between two accounts on one device.** Under this layout the same bytes uploaded by two accounts are two objects in two directories and two objects in R2. Deduplication was never available anyway: ADR-0148 made the id a mint rather than a hash.

## Considered alternatives

- **Row-addressed blobs, ADR-0173's `table.blobUrl(rowId)` and `table.writeBlob(rowId, bytes)`.** Refused three times over. One blob per row is a fact about Whispering recordings, not about rows; on desktop the id exists before the row is final, because the recorder mints it at `start` and the application writes it at `stop`; and "pure, synchronous, a stable URL" was only ever true on the arrangement where a host serves the bytes, which is half the platform.
- **Put every blob in IndexedDB and drop the host filesystem.** Refused on ADR-0226's terms: it costs the Rust progressive writer, puts multi-hour captures in IndexedDB, and routes uploads through WebView IPC instead of streaming.
- **Scope by data id, `.../<data-id>/blobs`.** Refused. The authority holds one copy per principal, and rows in two data ids of one app can cite one id, so a data-id scope would either duplicate bytes or force a lookup across scopes to find them.
- **Keep `blobs.local.*` and `blobs.remote.*`.** Refused. The nesting exists to hold a `remote: BlobRemote | null`, and a typed error carries that fact without asking a caller to read a property to learn an auth state.
- **`keep`, `restore`, and `release` instead of `upload`, `download`, and `purge`.** Refused. Keeping is a person's word and belongs in UI copy (ADR-0342), and `restore` already names an authority operation on generations (ADR-0272, ADR-0276).
- **A separate `epicenter.remoteBlobs` namespace.** Refused. It is the `local`/`remote` split spelled at the top level, and it separates `upload` from the `put` whose bytes it copies.
- **Add `kept` to `stat`.** Refused. `packages/server/src/routes/blobs.ts` mounts `POST`, `GET`, and `DELETE` and no `HEAD`, so `stat` would either make a network round trip on a call that reads local metadata, or report the row's `uploadedAt` back to the caller who owns it.
- **A Service Worker serving `/blobs/<id>` from IndexedDB, so `url` returns a plain string.** Refused. It buys the loss of `Disposable` at the cost of a worker registration in the boot path, a fetch handler that must be correct before any media element loads, and a second answer for what a blob URL means on desktop.
- **Collapse `@epicenter/blobs` into `@epicenter/app`.** Refused. `apps/epicenter/src/main.ts` uses `createBunBlobStore` from the Bun host, which never constructs an `Epicenter` handle, and `@epicenter/constants` already imports `BlobId` and `BLOB_ID_ROUTE_REGEX` for its route patterns.
