# Debug Storage & Stress Test Page

**Date**: 2026-03-16
**Status**: Implemented
**Author**: AI-assisted

## Overview

A dev-only debug page in Whispering that lets developers bulk-generate recordings, monitor Yjs document size, track browser/Tauri storage usage, and stress-test the workspace at scale. All from within the app itself.

## Motivation

### Current State

Performance benchmarks exist in `packages/workspace/src/workspace/benchmark.test.ts` (1,294 lines). They run in Bun's test runner and measure Yjs doc sizes, tombstone behavior, and operation throughput. The migration dialog has basic dev tools (seed/clear/reset) behind `import.meta.env.DEV`.

This creates problems:

1. **No in-app visibility**: The benchmarks run in a terminal. There's no way to see Yjs doc size, IndexedDB usage, or per-table row counts from inside the running app. Developers have to guess whether the app is approaching storage limits.
2. **No scalable stress testing**: The migration dialog seeds a fixed number of recordings (`MOCK_RECORDING_COUNT`). There's no way to generate 1,000 or 10,000 recordings on demand to test how the UI, queries, and storage behave at scale.
3. **No storage monitoring**: No dashboard shows browser storage quota vs usage, whether persistent storage is granted, or how much space the Yjs doc vs audio blobs consume.

### Desired State

A hidden debug page (dev-only) where developers can:
- See live storage metrics at a glance
- Generate N recordings with configurable parameters
- Watch Yjs doc size grow in real time during stress tests
- Understand storage costs and identify the breaking point for their device

## Research Findings

### Tombstone Behavior (from benchmarks + librarian research)

| Scenario | Y.Doc Size After | Notes |
|----------|-----------------|-------|
| 1,000 rows inserted | 77 KB | ~79 bytes/row |
| Delete all 1,000 rows | 35 bytes | Tombstones fully compacted |
| 5 add/delete cycles × 1,000 rows | 34 bytes per cycle | No accumulation |
| Delete 2 of 5 heavy rows (50K chars), add 2 new | +42 bytes (0.02%) | Minimal residue |
| 300 autosaves to 1 doc over 10 min | +37 bytes growth | YKV pattern is optimal |

**Key finding**: YKV (Y.Array + LWW) with `gc: true` (default) compacts tombstones to ~2 bytes each. Creating and deleting 1M recordings over time produces ~2MB tombstone overhead. This is a non-issue.

**Implication**: No special tombstone mitigation is needed. The existing architecture handles this well. The debug page should _confirm_ this rather than _solve_ it.

### Browser/Tauri Storage Limits

| Platform | Engine | Storage Limit | Notes |
|----------|--------|--------------|-------|
| Tauri Windows | WebView2 (Chromium) | 60% of disk | Most generous |
| Tauri macOS | WebKit (embedded) | ~15% of disk | Most restrictive |
| Tauri Linux | WebKit (embedded) | ~15% of disk | Same as macOS |
| Chrome browser | Chromium | 60% of disk | Web version |
| Safari browser | WebKit | ~60% of disk | Browser app gets more |
| Safari iOS | WebKit | ~15% embedded, ~60% PWA | Depends on context |

**Key finding**: `navigator.storage.estimate()` returns approximate `{ usage, quota }`. Not exact (padded to prevent fingerprinting), but good enough for a monitoring dashboard. `navigator.storage.persist()` prevents eviction.

**Implication**: On a 512GB Mac with Tauri, the limit is ~77GB. Far more than recordings metadata will ever need. The real storage concern is audio blobs (`serializedAudio: ArrayBuffer`), not workspace data.

### IndexedDB Performance Thresholds

| Record Count | Read Performance | Write Performance | Recommendation |
|-------------|-----------------|-------------------|----------------|
| <10K | Fast | Fast | No concerns |
| 10K: 50K | Noticeable slowdown | Batch recommended | Sweet spot ceiling |
| 50K: 100K | Significant | Need relaxed durability | Consider archiving |
| 100K+ | Problematic | Problematic | Need pagination/sharding |

**Key finding**: Chrome is ~5x slower than Safari/Firefox for large IndexedDB reads. Batching with `getAll()` improves performance 2-3x vs cursor iteration.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Page vs dialog | Dev-only route page | More space for metrics, tables, and controls than a dialog. Follows settings page pattern. |
| Location | `(app)/(config)/debug/+page.svelte` | Fits naturally in the existing (config) layout. Could add as settings sub-page later. |
| Dev guard | `import.meta.env.DEV` | Matches existing pattern (migration dialog, TanStack devtools). Zero production overhead. |
| Navigation | Link in NavItems.svelte | Same approach as migration dialog. Only visible in dev. |
| Stress test data shape | Match `recordings` table schema from `workspace.ts` | Must generate valid rows that the workspace API accepts: `{ id, title, subtitle, timestamp, createdAt, updatedAt, transcribedText, transcriptionStatus, _v: 1 }`. |
| Audio blobs in stress test | Optional/configurable | Audio blobs dominate storage but stress-testing the workspace layer doesn't require them. Offer a toggle. |
| Storage API usage | `navigator.storage.estimate()` | Standardized, works in all target browsers, available in Tauri WebView. |
| Yjs size measurement | `Y.encodeStateAsUpdate(ydoc).byteLength` | Standard approach per Yjs docs. Already used in existing benchmarks. |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Debug Page                                      │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │  Storage Dashboard                       │    │
│  │  ├── Browser quota / usage / percentage  │    │
│  │  ├── Persistent storage status           │    │
│  │  ├── Y.Doc encoded size (all tables)     │    │
│  │  └── Per-table row counts                │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │  Stress Test Panel                       │    │
│  │  ├── Count selector (100/500/1K/5K/10K)  │    │
│  │  ├── Content length (short/medium/long)  │    │
│  │  ├── Include audio blobs toggle          │    │
│  │  ├── [Generate] [Delete All] buttons     │    │
│  │  └── Results: timing, size delta, count  │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │  Tombstone Monitor                       │    │
│  │  ├── Current Y.Doc size                  │    │
│  │  ├── Estimated compacted size            │    │
│  │  ├── Tombstone overhead %                │    │
│  │  └── [Run add/delete cycle] test         │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

Data flows:
```
Debug Page
    │
    ├──▶ workspace.tables.recordings.set()     (bulk generate)
    ├──▶ workspace.tables.recordings.delete()  (bulk delete)
    ├──▶ workspace.tables.recordings.count()   (row counts)
    ├──▶ workspace.tables.recordings.getAll()  (enumerate)
    │
    ├──▶ Y.encodeStateAsUpdate(ydoc)           (doc size)
    ├──▶ navigator.storage.estimate()          (browser storage)
    └──▶ navigator.storage.persist()           (request persistence)
```

## Implementation Plan

### Phase 1: Storage Dashboard

- [x] **1.1** Create route at `src/routes/(app)/(config)/debug/+page.svelte`
- [x] **1.2** Add dev-only nav link in `NavItems.svelte` (Bug icon, both collapsed and expanded variants)
- [x] **1.3** ~~Implement `getStorageReport()` utility~~ Skipped: unnecessary abstraction, inlined directly
- [ ] **1.4** ~~Display browser storage: used / quota / percentage with progress bar~~ Deferred: nice-to-have, not essential
- [x] **1.5** Display Yjs doc size: `Y.encodeStateAsUpdate(workspace.ydoc).byteLength`
- [x] **1.6** Display per-table row counts for all 5 tables
- [ ] **1.7** ~~Add "Request Persistent Storage" button~~ Skipped: Tauri apps don't face eviction

### Phase 2: Stress Test Panel

- [x] **2.1** Create mock recording generator inline in the page component
- [x] **2.2** Add count selector (100, 500, 1000, 5000, 10000) and content length selector (short/medium/long)
- [x] **2.3** Add "Generate" button with `ydoc.transact()` batch + `performance.now()` timing
- [x] **2.4** Add "Delete All Recordings" button with browser `confirm()` dialog
- [x] **2.5** Display results: duration, throughput (rows/s), size before/after/delta
- [x] **2.6** Auto-refresh metrics after generate/delete operations

### Phase 3: Tombstone Monitor

- [ ] **3.1** ~~Show current vs compacted Y.Doc size~~ Deferred: benchmarks prove tombstones are a non-issue
- [ ] **3.2** ~~Show tombstone overhead percentage~~ Deferred
- [ ] **3.3** ~~Run Tombstone Test button~~ Deferred

## Edge Cases

### Tauri vs Browser storage API availability

1. `navigator.storage` might behave differently in Tauri's WebView
2. Should gracefully degrade if API is unavailable
3. Show "Not available" instead of crashing

### Very large stress tests (10K+)

1. UI might freeze during bulk insert
2. Consider using `requestAnimationFrame` or chunked inserts to keep UI responsive
3. Show a progress indicator for large batches

### Audio blob toggle

1. When "include audio blobs" is on, generating 1,000 recordings with 500KB audio each = 500MB
2. This could actually fill storage on constrained devices
3. Should show an estimate before generating and require explicit confirmation

## Open Questions

1. **Should this page also be accessible in production behind a hidden gesture?**
   - Some developers may want to debug storage on real user devices
   - Options: (a) dev-only, (b) dev + hidden URL param, (c) dev + settings toggle
   - **Recommendation**: Start dev-only. Add a hidden URL param (`?debug=1`) later if needed.

2. **Should stress tests generate audio blobs or just metadata?**
   - Audio blobs dominate storage but are separate from the workspace Y.Doc
   - Options: (a) metadata only, (b) audio only, (c) both with toggle
   - **Recommendation**: Default to metadata only (tests workspace layer). Add audio toggle for storage limit testing.

3. **Should the storage dashboard auto-refresh or manual refresh?**
   - Auto-refresh adds polling overhead; manual refresh is simpler
   - **Recommendation**: Manual refresh button. Auto-refresh after stress test operations only.

4. **How should per-table size breakdown work?**
   - Yjs encodes the entire doc as one binary. Per-table size requires encoding separate sub-docs or estimating proportionally.
   - **Recommendation**: Show per-table row counts (cheap). Show total doc size (cheap). Skip per-table byte breakdown for now. It requires sub-doc encoding which adds complexity.

## Success Criteria

- [ ] Debug page renders at `/debug` in dev mode only
- [ ] Storage dashboard shows browser quota, usage, percentage, and Y.Doc size
- [ ] Can generate 1,000 recordings and see doc size update
- [ ] Can delete all recordings and confirm doc size returns to baseline
- [ ] Tombstone monitor shows overhead percentage after add/delete cycles
- [ ] Page uses existing `@epicenter/ui` Field/Button patterns and matches app style
- [ ] No production code is affected (all behind `import.meta.env.DEV`)

## References

- `apps/whispering/src/lib/workspace.ts`: Recording table schema, workspace definition
- `apps/whispering/src/lib/migration/MigrationDialog.svelte`: Dev tools pattern (`import.meta.env.DEV`)
- `apps/whispering/src/lib/migration/migration-dialog.svelte.ts`: Svelte reactive state pattern for dialog
- `apps/whispering/src/lib/components/NavItems.svelte`: Navigation with dev-mode conditional
- `apps/whispering/src/routes/(app)/(config)/settings/+layout.svelte`: Settings layout pattern
- `packages/workspace/src/workspace/benchmark.test.ts`: Existing benchmarks (reference for data generation)
- `packages/workspace/src/workspace/create-tables.ts`: Table API (set, delete, count, getAll)

## Review

**Completed**: 2026-03-17
**Branch**: current working branch

### Summary

Built the essential subset of the spec: Y.Doc size display, per-table row counts for all 5 workspace tables, and a stress test panel with configurable count/content-length, bulk generate via `ydoc.transact()`, delete all with confirmation, and detailed timing results (duration, throughput, size before/after/delta). Added dev-only nav link (Bug icon) in both collapsed dropdown and expanded nav bar variants.

### Deviations from Spec

- **Skipped browser storage quota/usage** (1.4): The real constraint is Y.Doc size, not browser quota (~77GB on a 512GB Mac). Added as nice-to-have for later.
- **Skipped "Request Persistent Storage"** (1.7): Tauri apps don't face browser eviction. This solves a non-problem.
- **Skipped `getStorageReport()` utility** (1.3): Overengineered abstraction. The single `Y.encodeStateAsUpdate()` call is inlined directly.
- **Deferred Phase 3 (Tombstone Monitor)**: The spec's own research proves tombstones are a non-issue (2 bytes each with `gc: true`). The monitor would confirm a non-problem.
- **No separate utility file**: Everything is self-contained in the page component. Simple, no abstractions to maintain.

### Follow-up Work

- Add browser storage estimate display if storage debugging becomes needed
- Add audio blob generation toggle for storage limit testing
- Consider chunked inserts with progress indicator for 10K+ tests if UI freezing is observed
