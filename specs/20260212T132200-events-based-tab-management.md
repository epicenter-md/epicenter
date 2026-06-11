# Events-Based Tab Management

**Date**: 2026-02-12
**Status**: Superseded by `20260213T003200-suspended-tabs.md` (suspend/restore → now "save/saved") and `20260213T103000-request-dispatch.md` (cross-runtime dispatch)
**Author**: AI-assisted

> **Note**: "Suspended" terminology was renamed to "saved" in the codebase. See `specs/20260213T014300-rename-suspended-to-saved.md`.

## Overview

Redesign the tab manager's cross-device write path to use an events/commands table, replacing direct row mutation with a queued command model that works uniformly whether the target device is online or offline.

## Motivation

### Current State

The tab manager syncs tabs across devices using Yjs CRDTs. Each device writes its own tab rows (device-scoped). Y.Doc observers detect remote changes and call Browser APIs:

```typescript
// background.ts: current pattern
// Each device writes its own rows
tables.tabs.set(tabToRow(tab));

// Observer detects remote deletions and acts
client.tables.tabs.observe((changedIds, txn) => {
	for (const id of changedIds) {
		const result = client.tables.tabs.get(id);
		if (result.status === 'not_found') {
			// Remote deletion → close local browser tab
			await browser.tabs.remove(parsed.tabId);
		}
	}
});
```

This creates problems:

1. **No distinction between read state and write intent**: Deleting a row from the tabs table means "this tab was closed" and "I want this tab closed" simultaneously. There's no way to represent "pending close" or let the target device approve/reject.
2. **No offline command queue**: If the target device is offline, writing to its rows will sync eventually, but there's no way to batch, review, or partially approve queued operations.
3. **No audit trail**: When a tab closes via remote sync, there's no record of who requested it or when.

### Desired State

Cross-device operations flow through a commands table. Reading tabs is unchanged (read from state tables). Writing to another device always creates a command that the target device processes:

```
Actor: "Close tab X on Device B"
  → Creates command row (kind: "close", to_device_id: B, tab_id: X, state: "pending")
  → Device B's processor picks it up
  → Auto-executes: browser.tabs.remove(X), state → "executed"
```

## Research Findings

### Tab ID Stability in Chrome

Chrome tab IDs are session-scoped monotonically increasing integers.

| Event                          | Tab ID changes?   |
| ------------------------------ | ----------------- |
| Page navigation, reload        | No                |
| Tab moved between windows      | No                |
| Tab pinned/unpinned, discarded | No                |
| Service worker restarts (MV3)  | No                |
| Tab closed then Ctrl+Shift+T   | Yes: new ID      |
| Browser quit and relaunch      | Yes: all new IDs |
| Browser crash and restore      | Yes: all new IDs |

**Key finding**: Tab IDs are stable within a browser session. The existing `refetchTabs()` diff-and-reconcile pattern handles ID churn on restart correctly.

**Implication**: Commands reference tabs by `tab_id` (composite row ID `${deviceId}_${tabId}`) with an optional `url` field as a safety check. If the ID is stale, the processor marks it executed (noop: tab already gone).

### Awareness Protocol vs Persisted Events

| Mechanism          | Persisted? | Survives restart? | Good for                                 |
| ------------------ | ---------- | ----------------- | ---------------------------------------- |
| Yjs Awareness      | No         | No                | Ephemeral presence ("is device online?") |
| Events table (Yjs) | Yes        | Yes               | Queued commands, audit trail             |
| Custom event bus   | No         | No                | In-memory dispatch only                  |

**Key finding**: The server already has full awareness protocol support (`y-protocols/awareness`). Awareness is ideal for presence detection but cannot carry queued commands.

**Implication**: Use both. Awareness for "is device online?" UX hints. Events table for all command dispatch.

### Per-Tab Rows vs Per-Device Blob

This is the central storage design question. See Open Questions section for the full debate.

## Design Decisions

| Decision                   | Choice                                         | Rationale                                                                       |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Command dispatch mechanism | Events table in Yjs                            | Persisted, syncs automatically, survives restarts                               |
| Presence detection         | Awareness protocol                             | Ephemeral, already supported on server                                          |
| Event granularity          | Per-tab atomic (no grouping)                   | Each command independent; UI groups by time proximity if needed                 |
| Execution model            | Always enqueue; auto-execute (v1 has no "ask") | Unifies online/offline into one path                                            |
| Command schema             | Discriminated union via `type.or()`            | Type-safe per-kind fields; extensible by adding branches                        |
| Read-time overlays         | Computed in-memory, not stored                 | No stale derived state                                                          |
| Resolution field ownership | `to_device_id` only                            | Prevents LWW conflicts on state transitions                                     |
| Tab state storage          | Per-tab rows (current)                         | Benchmark confirmed: 10,000x better incremental sync, precise command targeting |

## Architecture

### Three Layers

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: State Tables (device-owned, read-heavy)           │
│  devices, tabs, windows, tab_groups                         │
│  Rule: ONLY the owning device writes its own rows           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: Commands Table (cross-device write intent)        │
│  Any device can CREATE a command targeting another device    │
│  Only the TARGET device writes resolution fields            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  LAYER 3: Awareness (ephemeral presence only)               │
│  "Is device B online right now?"                            │
│  UX hints only, never for command dispatch                 │
└─────────────────────────────────────────────────────────────┘
```

### Command Lifecycle

```
Device A (from)                     Yjs Doc                     Device B (to)
───────────────                     ───────                     ─────────────

User: "Close tab X on B"
  │
  ├─ 1. Create command row:
  │     kind: "close"
  │     from_device_id: A
  │     to_device_id: B
  │     tab_id: "B_42"
  │     state: "pending"
  │
  ├─ 2. UI overlay: tab X shows "pending close" badge
  │
  │                              ──── Yjs sync ────►
  │
  │                                                3. Command processor wakes:
  │                                                   - Sees pending command
  │                                                   - to_device_id matches self
  │                                                   - browser.tabs.remove(42)
  │                                                   - Writes: state="executed",
  │                                                     completed_at=now
  │
  │                              ◄──── Yjs sync ────
  │
  ├─ 4. Overlay clears, result logged
```

### Commands Table Schema

Uses a discriminated union via `type.or()` so each command kind has exactly the fields it needs. Shared base fields are merged into each variant with `base.merge()`.

```typescript
import { type } from 'arktype';

const base = type({
	id: 'string', // UUID
	from_device_id: 'string', // Who requested this command
	to_device_id: 'string', // Who must execute this command
	created_at: 'number', // ms since epoch
	state: "'pending' | 'executed' | 'failed'",
	'completed_at?': 'number', // When state left "pending"
	'error?': 'string', // Error message on failure
});

const commands = defineTable(
	type.or(
		base.merge({ kind: "'close'", tab_id: 'string', 'url?': 'string' }),
		base.merge({ kind: "'create'", url: 'string' }),
	),
);
```

**Key design rules:**

- **Independent commands**: Each command is a standalone row. "Close 10 tabs" = 10 rows. Each succeeds/fails independently. No `group_id`: UI groups by `(from_device_id, created_at ± threshold)` if needed.
- **Single-writer resolution**: Only `to_device_id` writes `state`, `completed_at`, and `error`. The sender creates the row and never touches those fields again. This prevents CRDT conflicts.
- **v1 is always auto-execute**: No `policy` field. Commands execute immediately when the target device picks them up. "Ask" mode can be added later by introducing a `policy` field and `approved`/`rejected` states.
- **Discriminated union**: `kind` narrows the type: `close` requires `tab_id`, `create` requires `url`. TypeScript enforces this at write time; arktype validates at read time.

### Command Types

Start minimal, just two kinds:

| Kind     | Actor intent                | Target action                  |
| -------- | --------------------------- | ------------------------------ |
| `close`  | "Close tab X on device B"   | `browser.tabs.remove(tabId)`   |
| `create` | "Open this URL on device B" | `browser.tabs.create({ url })` |

No `tab.` prefix. The table is already scoped to tab commands. If non-tab commands are added later, the discriminated union extends naturally with new `base.merge({ kind: "'new_kind'", ... })` branches.

`create` on target + `close` on source = "move tab" (two independent commands).

Additional kinds (pin, mute, move) can be added later by adding new branches to `type.or()`.

## Open Questions

### 1. Per-Tab Rows vs Per-Device Blob: RESOLVED

**Decision**: Per-tab rows (keep current approach).

A benchmark was run comparing both approaches using the real 19-field tab schema, 4 devices × 50 tabs = 200 tabs. Key results:

| Metric                          | Per-Tab Rows  | Per-Device Blob               |
| ------------------------------- | ------------- | ----------------------------- |
| Y.Doc size (200 tabs)           | 77 KB         | 81 KB                         |
| Incremental sync (1 tab update) | 2 bytes       | ~20 KB                        |
| Command targeting               | Direct row ID | Deserialize + URL match       |
| Single tab delete               | O(1)          | Parse → filter → re-serialize |

The blob is faster for batch reads (microseconds; invisible to users), but per-tab rows are 10,000x better on incremental sync. The Yjs LWW implementation's delete+push within a single transaction produces no net state vector change, so single-tab updates cost essentially nothing on the wire. The blob resends the entire device's tab state for every change.

Per-tab rows also give precise command targeting (the commands table references `tab_id` directly) and slightly smaller Y.Doc size.

See `20260212T115500-tab-manager-per-device-state.md` (marked Superseded) for the full benchmark data and the original blob proposal.

### 2. Default Policy: "auto" vs "ask": RESOLVED

**Decision**: v1 is always auto-execute. No `policy` field in the schema.

When/if "ask" mode is needed, add a `policy: "'auto' | 'ask'"` field and `approved`/`rejected` states. This is a schema version bump, not a redesign.

### 3. Command Retention

Resolved commands accumulate forever in Yjs. Options:

- Delete after N days
- Keep last N per device
- Compact on read (delete old resolved commands when processing new ones)

**Recommendation**: Defer. Start with no cleanup; add retention when it becomes a problem.

## Edge Cases

### Stale Command After Browser Restart

1. Device A sends `close` command targeting `tab_id: "B_42"`
2. Device B restarts Chrome before processing
3. Tab 42 no longer exists (new session, new IDs)
4. Processor checks `browser.tabs.get(42)` → error
5. Optionally checks `url` field against all current tabs as fallback
6. Marks `state: 'executed'` (noop: tab already gone, goal achieved)

### Service Worker Restart Mid-Processing

1. Command processor starts executing a command
2. Chrome terminates service worker (MV3 30s limit)
3. Service worker restarts, processor re-scans pending commands
4. Same command appears again (still `state: 'pending'`)
5. Execution must be idempotent: "tab already gone" → mark `executed`

### Bulk Close from Remote Device

1. Device A sends 10 independent `close` commands (10 rows, no grouping)
2. Device B processes each independently
3. 7 tabs still exist → `state: 'executed'`; 3 already gone → `state: 'executed'` (noop)
4. UI on Device A groups by `(from_device_id, created_at ± 500ms)` for display

## Implementation Plan

### Phase 1: Commands Table Schema

- [ ] **1.1** Add `base` type and discriminated union `commands` table to `browser.schema.ts` using `type.or()` with `base.merge()`
- [ ] **1.2** Export in `BROWSER_TABLES`
- [ ] **1.3** Add type exports (`CloseCommand`, `CreateCommand`, `Command`)
- [ ] **1.4** Spike: verify `defineTable` handles arktype union schemas at runtime (validation on read, set on write)

### Phase 2: Command Processor

- [ ] **2.1** Create `command-processor.ts`: observer on commands table
- [ ] **2.2** Implement `close` execution (idempotent, with optional `url` safety check)
- [ ] **2.3** Implement `create` execution
- [ ] **2.4** Wire processor into `background.ts`: filter commands where `to_device_id` matches self

### Phase 3: Command Creation API

- [ ] **3.1** Create helper functions for dispatching commands (`closeTabOnDevice`, `openUrlOnDevice`)
- [ ] **3.2** Wire into popup UI or CLI

### Phase 4: Read-Time Overlays

- [ ] **4.1** Create `command-overlay.ts`: computes pending state from unresolved commands
- [ ] **4.2** Integrate into tab reading logic (overlay pending badges)

### Phase 5: Awareness Integration

- [ ] **5.1** Publish device online status via awareness protocol
- [ ] **5.2** Use presence for UX hints in popup ("Device B is online: will execute immediately")

## Success Criteria

- [ ] Cross-device tab close works via commands table (`kind: 'close'`)
- [ ] Cross-device tab create (send URL) works via commands table (`kind: 'create'`)
- [ ] Commands are persisted and survive service worker restarts
- [ ] Pending commands are visible in UI overlay
- [ ] Stale commands noop safely (no wrong-tab closes)
- [ ] Discriminated union validated at runtime: invalid commands return `status: 'invalid'` on read
- [ ] Only `to_device_id` mutates resolution fields (no CRDT conflicts)

## References

- `apps/tab-manager/src/entrypoints/background.ts`: Current sync logic
- `apps/tab-manager/src/lib/epicenter/browser.schema.ts`: Current table definitions
- `apps/tab-manager/src/lib/device-id.ts`: Device ID and composite ID parsing
- `packages/epicenter/src/static/define-table.ts`: defineTable API
- `packages/epicenter/src/server/sync/index.ts`: Awareness protocol on server
- `specs/20260202T203000-modernize-tab-manager-client.md`: Previous modernization spec

---

## Appendix: Per-Tab vs Blob Benchmark Summary

The per-tab vs blob debate was resolved by running a benchmark using `createTables(ydoc, { ... })` with the full 19-field tab schema from `browser.schema.ts`. The benchmark compared initial writes, single-tab updates, reads, deletes, Y.Doc size, and incremental sync payload for both approaches across 4 devices × 50 tabs.

| Metric                          | Per-Tab Rows | Per-Device Blob               |
| ------------------------------- | ------------ | ----------------------------- |
| Y.Doc size (200 tabs)           | 77 KB        | 81 KB                         |
| Incremental sync (1 tab update) | 2 bytes      | ~20 KB                        |
| Single tab delete               | O(1)         | Parse → filter → re-serialize |

The critical finding: `YKeyValueLww`'s delete+push within a single Yjs transaction produces essentially no incremental sync payload (2 bytes = empty update header), while the blob resends the entire ~20KB device state for every tab change.

See `20260212T115500-tab-manager-per-device-state.md` for the full blob proposal (marked Superseded).
