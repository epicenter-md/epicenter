# Whispering Cloud Sync: Remainder (Audio to R2, Daemon Mount)

**Date**: 2026-07-01
**Status**: Draft
**Owner**: Braden
**Carries forward from**: `apps/whispering/specs/20260602T140000-cloud-sync-and-account.md` (deleted). Auth wiring and authority-specific reload behavior shipped and are verified live in `apps/whispering/src/lib/whispering/whispering.active.ts` and `apps/whispering/src/lib/whispering/reload-on-principal-change.ts`, so they are not repeated here. Signed-out local data and signed-in principal data remain separate authorities; moving data between them is an explicit app-owned import, never a runtime promotion or migration. Release-local device settings remain separate from synchronized settings opened through `whisperingWorkspace.documents.settings`. This file carries only the unbuilt audio-to-R2 and Tauri daemon work, plus the remaining product questions.

## One Sentence

Recording audio stays device-local by default; the unbuilt remainder is an opt-in per-recording upload to R2 through principal-scoped bearer-authed routes, plus a headless Tauri daemon mount for background sync, both still undecided on the open questions below.

## Phase 5: Audio to R2 (opt-in)

- [ ] **5.1** Add a required or nullable `audioUpload` field to the release-local recording lens. Existing rows that do not conform remain honest invalid data until an app-owned repair patches them.
- [ ] **5.2** R2 bucket binding + principal-scoped PUT/GET routes in `packages/server` / `apps/api/worker`.
- [ ] **5.3** Per-recording "Upload audio" action + UI; cross-device "Download / Play" vs "audio on original device."
- [ ] **5.4** Decide + implement audio-at-rest encryption (see Open Questions).

### Recording row shape

Audio lives in Dexie today (`$lib/services/blob-store`), separate from the Yjs metadata. Keep it there; add a pointer on the recording row.

```txt
recordings row gains:
  audioUpload: nullable({ status: 'uploaded', r2Key, bytes, uploadedAt })   # null = device-local only

Per recording:
  [Upload audio]  -> encode -> (encrypt?) -> PUT via API -> set audioUpload on row
On another device:
  audioUpload != null  -> [Download / Play] (GET from API)
  audioUpload == null  -> "Audio is on the device that recorded it"
```

### Route shape

New principal-scoped, bearer-authed routes in `packages/server` (consumed by `apps/api` worker) backed by an R2 bucket binding:

```txt
PUT  /api/audio/:recordingId    # upload (presigned or proxied)
GET  /api/audio/:recordingId    # download/stream
```

### Billing note

R2 storage/egress is hosted-personal-cloud only; keep it in `apps/api/worker`, never in the shared library seam.

## Phase 6 (deferred): Tauri daemon mount

- [ ] **6.1** `workspaces/whispering/daemon.ts` via `defineMount` for headless background sync.

## Open Questions

1. **Explicit import between local and principal authorities.**
	- Signed-out local data and signed-in principal data never reconcile implicitly. If the product needs a move or copy, define a visible app-owned import that leaves the source intact and reports partial failure honestly.
	- **Recommendation**: keep authorities separate until a concrete import workflow is required. Do not add sign-in promotion, mirroring, or hidden fallback.

2. **Audio encryption at rest in R2.**
   - Options: (a) plaintext in R2 (server-readable, simplest, consistent with today's plaintext-body gap); (b) client-side keyring-encrypt the whole blob before PUT and decrypt on GET (E2E, but no range/streaming).
   - **Recommendation**: (b) whole-blob encrypt for short recordings, since the keyring is already in hand and this is someone's voice. Confirm against the encryption skill and relay/body model. Leave open.

3. **Mobile / narrow-viewport placement.**
   - The sidebar footer is desktop-only; `BottomNav` has four fixed slots.
   - **Recommendation**: rely on the Settings -> Account page on mobile; optionally a small account glyph in `BottomNav`. Defer the exact mobile chrome.

4. **OAuth launcher on Tauri.**
   - Redirect vs deep-link vs OOB. tab-manager uses an extension launcher; whispering is Tauri.
   - **Recommendation**: deep-link callback if a scheme is registered, else OOB paste. Verify against `packages/auth` machine-auth + browser launchers. Leave open.
