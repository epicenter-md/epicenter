# Wave H removed/degraded feature ledger (temporary)

Working ledger for the Wave H pre-gate migration. Every entry records a
behavior that was removed, degraded, or deliberately deferred while
completing the two-plane runtime migration. This file must be reconciled
(entries resolved, promoted into ADRs/docs, or accepted) and deleted before
Wave H is finally complete.

## 1. Device Add verification (`verifyAdded`) and the automatic delete-after-copy gate

- **App/surface:** `@epicenter/workspace/sqlite` Account runtimes (browser
  and Bun); no production app called it (Honeycrisp and Whispering have no
  capture/add/delete callers yet).
- **Former behavior:** After `add()`, `verifyAdded(definition, copy)` settled
  one scalar cut, took a confirmed snapshot, and proved every copied row
  address canonically live plus every copied document byte set contained in
  locally durable state (`verified` / `unsettled` / `missing` outcomes). Its
  sole purpose was authorizing automatic Device-source deletion after a copy.
- **What changed:** Deleted: `verifyAdded` on both Account runtimes,
  `DeviceAddVerification`, `missingAddedContent`, `containsDocumentState`,
  the replica's `captureConfirmed()` confirmed-snapshot cut, the
  `capture-confirmed` Worker operation, and the verification-only tests.
  ADR-0147 (Proposed) was amended: copy is optional, the Device source
  remains by default, and local deletion is a separate explicit destructive
  action.
- **Why legacy-bound:** The product clarification (2026-07-18) makes Device
  mode a permanent first-class mode; a successful copy authorizes nothing,
  so the entire verification family served a promise that no longer exists.
- **User impact:** None today (zero production callers). A future copy flow
  loses the "these rows did not land" report; a create silently refused at a
  retained deletion marker is simply absent from the account while the
  Device source still holds it.
- **Replacement:** Idempotent `capture()`/`add()` (safe to re-run) plus the
  explicit `delete()` Device primitive with its own confirmation, surfaced
  later in settings.
- **To revisit:** If a copy-report UX is ever wanted, rebuild it as a
  non-gating diff view over `capture()` output vs. account reads; do not
  reintroduce a deletion gate.

## 2. Whispering desktop surface does not sync workspaces with the account

- **App/surface:** Whispering inside the Epicenter desktop host
  (`whispering.tauri.ts` → desktop workspace runtime → Bun Device runtime).
- **Former behavior (promised, not delivered):** The account settings screen
  promised cross-device sync after sign-in on every surface; the desktop
  surface actually runs a Device-only Bun-owned runtime, so nothing synced.
- **What changed:** The desktop surface keeps the Device-only runtime
  (matching the host's recorded "sign-in sync is a later enhancement"
  posture); the settings copy now states that desktop workspace data stays
  local and sign-in powers hosted transcription only. (See the
  whispering commit in this wave.)
- **Why legacy-bound:** Wiring account sync through the Bun sidecar needs the
  WebView to hand its OAuth grant to the sidecar process, a new
  credential-transfer seam; preserving the copy without the seam preserved a
  false promise.
- **User impact:** Desktop Whispering recordings/settings do not follow the
  account to other devices; browser Whispering does sync.
- **To revisit:** Design the host credential seam (WebView → sidecar bearer
  handoff), then swap `createDesktopWorkspaceOwner` to an Account Bun
  runtime when signed in.

## 3. Honeycrisp standalone Tauri build keeps the browser runtime (no native SQLite owner)

- **App/surface:** Honeycrisp.app (standalone Tauri shell).
- **Former behavior:** None (the Tauri build was broken in production: the
  'opfs' VFS required COOP/COEP isolation the Tauri protocol never served).
- **What changed:** The WebView runs the same browser runtime as the web
  build (SAH-pool OPFS SQLite worker + IndexedDB document store), now viable
  without isolation headers. A native-SQLite desktop workspace owner (the
  epicenter-host pattern) is deliberately not built for the standalone app.
- **Why deferred:** A desktop owner requires a Bun sidecar (process
  supervision, packaging, loopback auth) duplicating the entire epicenter
  host machinery for one app.
- **User impact:** Honeycrisp desktop data lives in WebView browser storage
  (OPFS/IndexedDB) rather than plain files; storage is subject to WebView
  data-store lifetime. Sync behavior is identical to the browser build,
  including Account sync when signed in.
- **To revisit:** If Honeycrisp desktop earns native storage, host it inside
  the Epicenter desktop host (whose owner already opens the honeycrisp
  definition) rather than growing a second sidecar.

## 4. Second-tab behavior: newest tab wins (older tab degrades)

- **App/surface:** Every browser-runtime app (Honeycrisp, Whispering web).
- **Former behavior:** At HEAD before this wave the second tab failed its
  entire boot (white screen) against the exclusive storage lease; under the
  earlier legacy Yjs runtime, multi-tab worked concurrently.
- **What changed:** The storage lease steals (newest tab wins): the new tab
  gets full ownership and all data; the previous tab stops syncing and every
  later workspace operation there fails loudly with
  `WorkspaceStorageMovedError`.
- **Why legacy-bound:** The SAH-pool VFS admits one live owner per pool
  directory, and one-SQLite-owner was already the runtime's design; true
  concurrent multi-tab needs a SharedWorker owner.
- **User impact:** Using the same app in two tabs no longer works
  concurrently; the most recently opened tab is the live one.
- **To revisit:** Move the records Worker behind a SharedWorker (one owner,
  many pages) and delete the steal path.

## 5. iPhone topology harness route ships in the Honeycrisp bundle (temporary)

- **App/surface:** Honeycrisp `/dev/topology` route.
- **What changed:** A dev-only harness route exists in production builds so
  the physical-iPhone gate can run against a deployed HTTPS host. It opens
  1/2/4/8 row documents simultaneously in one page.
- **User impact:** An unlinked route exists; it operates only on the
  operator's own workspace data.
- **To reconcile:** Delete the route when the topology gate has produced its
  PASS/FAIL and ADR-0145/0146 are resolved.
