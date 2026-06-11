# Fuji Stress Test: 1k/10k Notes (In-App UI)

## Goal

Build an in-app `/stress-test` page in `apps/fuji` that generates 1,000 or 10,000 entries with realistic data via the workspace API. Stress tests both the CRDT layer and the UI rendering under load. Measures insertion time, Y.Doc binary size, and read performance. All visible in the browser.

## Context

- Fuji's data model: `entries` table (v2) with fields `id`, `title`, `subtitle`, `type`, `tags`, `pinned`, `rating`, `deletedAt`, `date`, `createdAt`, `updatedAt`, `_v: 2`
- Each entry has a `.withDocument('content')` creating a per-entry Y.Doc with a timeline → Y.XmlFragment for ProseMirror rich text
- Existing reference: `packages/workspace/scripts/stress-test-static.ts`: raw Y.Doc + `createTables`, measures add/delete cycles and binary size
- Fuji factory: `createFujiWorkspace()` returns a workspace builder with `entries.create`, `entries.bulkCreate`, and `tables.entries.bulkSet`
- `bulkSet` already chunks in 1k batches with `onProgress` callback

## Design

**In-app page at `/stress-test`** so the UI renders the entries after insertion. Testing both CRDT perf and Svelte rendering under load.

**Uses the live `workspace` client from `$lib/client`** (with IndexedDB persistence and sync extensions). This is the real app workspace, so generated entries show up in the sidebar, table view, etc.:the actual stress test scenario.

**Controls:**
- Count selector: 1,000 or 10,000
- "Generate" button to kick off insertion
- "Clear Generated" button to remove stress test entries
- Live progress display during generation

**Results panel** shows insertion time, row count, and Y.Doc binary size after completion.

**Tag all generated entries with `["stress-test"]`** so they can be identified and bulk-deleted.

## Files

| File | Purpose |
|---|---|
| `apps/fuji/src/routes/stress-test/+page.svelte` | Stress test UI page |

## Implementation

### Todo

- [x] Update spec to reflect UI-based approach
- [ ] Create `apps/fuji/src/routes/stress-test/+page.svelte`
- [ ] Implement data generation (varied titles, dates, tags, types, ratings)
- [ ] Wire generate button to `workspace.tables.entries.bulkSet`
- [ ] Show progress during insertion (bulkSet onProgress callback)
- [ ] Measure and display: insertion time, row count, Y.Doc binary size
- [ ] Add "Clear Generated" button that deletes entries tagged `stress-test`
- [ ] Verify no type errors

### Data Generation

```
Titles:     Pool of ~30 realistic note titles, picked randomly + index suffix for uniqueness
Subtitles:  Pool of ~15 editorial hooks, or empty string (50% chance)
Types:      ["article", "thought", "idea", "research", "journal"]: pick 0-2 randomly
Tags:       Always includes "stress-test" + 0-2 from ["draft", "published", "favorite", "personal", "work", "code", "design", "writing"]
Rating:     0-5 integer, weighted toward 0 (unrated)
Date:       Random date within last 2 years
Pinned:     5% chance of true
```

## Review

_To be filled after implementation._
