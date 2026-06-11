# Remove Commands Table and Awareness

**Date**: 2026-03-11
**Status**: Implemented
**Author**: AI-assisted design session

## Overview

Remove the `commands` table, command consumer infrastructure, and awareness config from the tab manager workspace. These serve an unbuilt cross-device AI mutation feature with no current consumers. Local AI tool calling already works without them via TanStack AI's client tool pattern.

## Motivation

### Current State

The workspace definition includes a `commands` table and awareness config:

```typescript
// workspace.ts: commands table (lines 506-557)
const commandsTable = defineTable(
  commandBase.merge(
    type.or(
      { action: "'closeTabs'", tabIds: 'string[]', 'result?': ... },
      { action: "'openTab'", url: 'string', ... },
      // ... 6 more action variants
    ),
  ),
);

// workspace.ts: awareness config (lines 576-579)
awareness: {
  deviceId: type('string'),
  deviceType: type('"browser-extension" | "desktop" | "server" | "cli"'),
},

// workspace.ts: initialization (lines 875-888)
void workspaceClient.whenReady.then(async () => {
  const deviceId = await getDeviceId();
  workspaceClient.awareness.setLocal({
    deviceId,
    deviceType: 'browser-extension',
  });
  startCommandConsumer(
    workspaceClient.tables.commands,
    workspaceClient.tables.savedTabs,
    deviceId,
  );
});
```

A dedicated `commands/` directory houses the consumer and action executors:

```
apps/tab-manager/src/lib/commands/
├── constants.ts       ← COMMAND_TTL_MS = 30_000
├── consumer.ts        ← Background worker command observer + dispatcher
├── actions.ts         ← Per-action Chrome API execution functions
└── quick-actions.ts   ← Command palette actions (UNRELATED to command queue)
```

This creates problems:

1. **Dead infrastructure.** The commands table was designed for server-side AI mutation tools (spec `20260223T200500`). Phase 3-4 of that spec. The server-side tools that write to the commands table. Were never built. `packages/server/src/ai/tools/` doesn't exist. The command consumer observes a table that nobody writes to.

2. **Unnecessary Y.Doc overhead.** Every command variant (8 discriminated union branches) syncs across all devices via Y.Doc. The consumer runs on every device, checking every command change against its own `deviceId`. For a table with zero rows, this is pure waste. Observer registration, schema validation slots, sync bandwidth for an empty Y.Array.

3. **Awareness is write-only.** Awareness is set once on startup (`setLocal({ deviceId, deviceType })`) and never read anywhere. No UI component, no server endpoint, no other code path calls `awareness.getAll()`, `awareness.getLocal()`, or `awareness.observe()`. The `devices` table already stores `name`, `lastSeen`, and `browser` for every device, covering the same "who's out there" question.

4. **The execute functions are tangled.** `$lib/commands/actions.ts` exports 8 Chrome API wrappers (`executeCloseTabs`, `executeOpenTab`, etc.) used by *both* the command consumer *and* the `.withActions()` mutation handlers. Removing the consumer still requires these functions, but they're currently co-located with dead code.

### Desired State

- The `commands` table, `CommandId` type, `commandBase` schema, and command consumer are gone
- Awareness config is removed from the workspace definition
- The `whenReady` block only handles device registration (if needed) without awareness or command consumer setup
- Execute functions (`executeCloseTabs`, etc.) live in a standalone module, still used by `.withActions()` mutation handlers
- `quick-actions.ts` survives untouched. It's a command palette feature, unrelated to the command queue
- No behavioral change: AI chat tools continue working via TanStack AI client-side execution

## Research Findings

### Why Commands Exist (and Why They Don't Matter Now)

The commands table was designed for one specific flow documented in `specs/20260223T200500-ai-tools-command-queue.md`:

```
User on Phone → AI Chat (server) → writes command to Y.Doc
  → Y.Doc syncs to Laptop → Laptop background worker observes
  → executes browser.tabs.remove() → writes result back
  → Server observes result → AI responds "Closed 5 tabs"
```

This requires the server to write commands and await results. That server-side code was never built. The spec's Phase 3 (`createAIPlugin` with `getDoc` callback, server-side read tools) and Phase 4 (`waitForCommandResult`, server-side mutation tools) remain unchecked.

### How AI Tool Calling Actually Works Today

The current AI chat uses TanStack AI's isomorphic tool pattern:

```
User sends message → Client sends to server (POST /ai/chat)
  → Server AI decides to call tool (e.g., closeTabs)
  → Server sends tool call request in SSE stream
  → CLIENT receives tool call, executes via actionContext.clientTools
  → Client sends tool result back to server
  → Server AI generates final response
```

The `.withActions()` mutation handlers already call Chrome APIs directly:

```typescript
// workspace.ts: these execute on the CLIENT, not the server
tabs: {
  close: defineMutation({
    handler: async ({ tabIds }) => {
      const deviceId = await getDeviceId();
      return executeCloseTabs(tabIds, deviceId);  // Direct browser.tabs.remove()
    },
  }),
  // ...
},
```

Client tools don't need a command queue. The mutation runs where the Chrome APIs live. On the device with the browser.

### What Cross-Device Mutations Would Require

If cross-device AI mutations are ever needed, commands aren't the only path:

| Approach | Mechanism | Complexity |
|---|---|---|
| Command queue (current spec) | Y.Doc table with observer + TTL | High. Requires server tools, device targeting, timeout handling |
| Direct server-to-device RPC | Server sends WebSocket message to target device | Medium. Requires device registry, connection tracking |
| Shared "intent" table | Write desired state, device reconciles on next sync | Low. But eventual, not immediate |

The command queue is the most complex option for a feature that may never ship. If cross-device mutations become important, the server-to-device approach would likely be simpler and more reliable (no 30s TTL, no stale command cleanup).

### Awareness vs Devices Table

| Capability | Awareness | `devices` Table |
|---|---|---|
| Real-time online status | Yes (auto-clears on disconnect) | Approximate (`lastSeen` heuristic) |
| Device identity | `deviceId`, `deviceType` | `id`, `name`, `browser`, `lastSeen` |
| Persisted across restarts | No (ephemeral) | Yes (Y.Doc CRDT) |
| Current consumers | Zero | UI device list, AI `listDevices` query |
| Cross-device visibility | Only while connected to same server | Always (synced via Y.Doc) |

Awareness provides true real-time presence, but the devices table with a "seen in last 60s = online" heuristic is sufficient for a tab manager. The difference only matters for features like "live cursor positions" or "typing indicators". Neither applies here.

**Important:** Removing awareness from the tab-manager workspace does NOT remove awareness from `@epicenter/workspace`. The workspace package's `createAwareness`, `AwarenessHelper` types, and sync extension awareness support remain intact for other apps that need it.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Remove commands table | Yes | Zero writers, zero UI consumers. Server tools never built. Dead code. |
| Remove awareness config | Yes | Write-only. Never read. `devices` table covers the same ground. |
| Keep execute functions | Yes, relocate | `.withActions()` mutation handlers depend on them |
| New location for execute functions | `$lib/tab-actions.ts` | Standalone module, no coupling to removed infrastructure |
| Keep `quick-actions.ts` | Yes, move to `$lib/components/` or `$lib/` | It's a command palette feature, nothing to do with the command queue. With `commands/` deleted, it needs a new home. |
| Remove `CommandId` branded type | Yes | No table uses it anymore |
| Remove `commandBase` schema | Yes | Only used by `commandsTable` |
| Keep `@epicenter/workspace` awareness API | Yes | Other workspaces may use it. This is a tab-manager-only removal. |
| Simplify `whenReady` block | Yes | Remove awareness set + command consumer start. Keep device registration if the devices table still needs it there. |

## Architecture

### Before

```
┌──────────────────────────────────────────────────────────────┐
│  workspace.ts                                                 │
│                                                               │
│  defineWorkspace({                                            │
│    awareness: { deviceId, deviceType },     ← REMOVE          │
│    tables: {                                                  │
│      devices, tabs, windows, tabGroups,                       │
│      savedTabs, bookmarks,                                    │
│      conversations, chatMessages,                             │
│      commands,                              ← REMOVE          │
│    },                                                         │
│  })                                                           │
│                                                               │
│  whenReady → setLocal(awareness)            ← REMOVE          │
│           → startCommandConsumer(...)       ← REMOVE          │
│                                                               │
│  $lib/commands/                                               │
│  ├── constants.ts     (COMMAND_TTL_MS)      ← REMOVE          │
│  ├── consumer.ts      (startCommandConsumer)← REMOVE          │
│  ├── actions.ts       (execute* functions)  ← RELOCATE        │
│  └── quick-actions.ts (command palette)     ← RELOCATE        │
└──────────────────────────────────────────────────────────────┘
```

### After

```
┌──────────────────────────────────────────────────────────────┐
│  workspace.ts                                                 │
│                                                               │
│  defineWorkspace({                                            │
│    tables: {                                                  │
│      devices, tabs, windows, tabGroups,                       │
│      savedTabs, bookmarks,                                    │
│      conversations, chatMessages,                             │
│    },                                                         │
│  })                                                           │
│                                                               │
│  .withActions(({ tables }) => ({                              │
│    // Same actions, same handlers, same client tools          │
│    // Imports from $lib/tab-actions instead of                │
│    //   $lib/commands/actions                                 │
│  }))                                                          │
│                                                               │
│  $lib/tab-actions.ts        (execute* functions, relocated)   │
│  $lib/quick-actions.ts      (command palette, relocated)      │
│  $lib/commands/              ← DELETED                        │
└──────────────────────────────────────────────────────────────┘
```

### What Changes in Data Flow

Nothing, for any currently-working feature:

```
BEFORE (AI chat, same device):
  User → Server AI → SSE tool call → Client executes via clientTools → Result
  (commands table: unused, command consumer: running but idle)

AFTER (AI chat, same device):
  User → Server AI → SSE tool call → Client executes via clientTools → Result
  (identical. No commands table involved)

BEFORE (cross-device AI mutation):
  Not implemented. Server tools don't exist. Dead path.

AFTER (cross-device AI mutation):
  Still not implemented. No regression.
```

## Implementation Plan

### Phase 1: Relocate Execute Functions

- [x] **1.1** Create `apps/tab-manager/src/lib/tab-actions.ts`: move all 8 `execute*` functions and the `nativeTabId` helper from `$lib/commands/actions.ts`
- [x] **1.2** Update `workspace.ts` imports: change `from '$lib/commands/actions'` to `from '$lib/tab-actions'`
- [x] **1.3** Verify: `bun run check` passes, all mutation handlers still reference the correct functions

### Phase 2: Relocate Quick Actions

- [x] **2.1** Move `$lib/commands/quick-actions.ts` to `$lib/quick-actions.ts`
- [x] **2.2** Update import in `$lib/components/CommandPalette.svelte`: change `from '$lib/commands/quick-actions'` to `from '$lib/quick-actions'`
- [x] **2.3** Verify: command palette still renders and quick actions still work

### Phase 3: Remove Commands Infrastructure

- [x] **3.1** Delete `$lib/commands/constants.ts`
- [x] **3.2** Delete `$lib/commands/consumer.ts`
- [x] **3.3** Delete `$lib/commands/actions.ts` (now empty after relocation)
- [x] **3.4** Delete `$lib/commands/` directory
- [x] **3.5** Remove from `workspace.ts`:
  - `commandBase` schema (lines 272-277)
  - `commandsTable` definition (lines 506-557)
  - `Command` type export (line 558)
  - `CommandId` branded type and runtime pipe (lines 127-128)
  - `commands: commandsTable` from the `tables` object (line 590)
  - `import { startCommandConsumer } from '$lib/commands/consumer'` (line 39)
  - `startCommandConsumer(...)` call in `whenReady` block (lines 883-887)
- [x] **3.6** Verify: `bun run check` passes

### Phase 4: Remove Awareness

- [x] **4.1** Remove from `workspace.ts`:
  - `awareness` config from `defineWorkspace` call (lines 576-579)
  - `workspaceClient.awareness.setLocal(...)` from `whenReady` block (lines 877-880)
- [x] **4.2** Simplify the `whenReady` block: if nothing remains, remove it entirely. If device registration still happens there, keep only that.
  > **Note**: Nothing remained after removing awareness + command consumer. The `whenReady` block was removed entirely.
- [x] **4.3** Verify: `bun run check` passes, workspace client still initializes correctly

### Phase 5: Cleanup

- [x] **5.1** Remove unused imports from `workspace.ts` (anything only used by deleted code)
- [x] **5.2** Verify no other files in the app import from deleted paths (`$lib/commands/actions`, `$lib/commands/consumer`, `$lib/commands/constants`)
- [x] **5.3** Run full type check: `bun run check`
- [x] **5.4** Run tests if applicable: `bun test`

## Edge Cases

### Existing Y.Doc Data with Commands Rows

If any device ever had command rows written to its Y.Doc (e.g., during testing), those rows will persist in IndexedDB as orphaned data in the `table:commands` Y.Array. This is harmless:

1. No code reads the Y.Array anymore
2. Y.Doc doesn't fail on unknown arrays. It just ignores them
3. The data will be garbage-collected naturally if the user clears extension storage

No migration needed. No cleanup script required.

### Awareness State in y-websocket

The y-websocket provider propagates awareness alongside document state. Removing awareness from the workspace definition means:

1. No local awareness state is set → nothing propagates
2. Other peers' awareness messages are ignored (no observer registered)
3. The WebSocket provider still handles awareness frames, but they're empty/no-ops
4. No error, no crash. Awareness is optional in the y-protocols spec

### Quick Actions Still Work

`quick-actions.ts` imports from `$lib/state/browser-state.svelte`, `$lib/state/saved-tab-state.svelte`, `$lib/utils/format`, and `$lib/workspace` (for `parseTabId`, `TabCompositeId`). None of these are affected by the removal. It calls `browser.tabs.*` directly. No dependency on the command queue.

### AI Chat Continues Working

The chat state (`chat-state.svelte.ts`) uses:
- `actionContext.clientTools`: derived from `.withActions()`, unaffected
- `actionContext.toolDefinitions`: sent to server, unaffected
- `workspaceClient.tables.conversations` / `.chatMessages`: unaffected

The AI can still search tabs, list windows, count domains (read tools), and close/open/pin/save/group/mute/reload tabs (mutation tools executed client-side). No regression.

## Open Questions

1. **Should we keep `CommandId` for potential future use?**
   - Options: (a) Remove entirely, (b) Keep as unused type
   - **Recommendation**: Remove. Branded types are trivial to recreate. Dead code is worse than re-typing a two-line definition later.

2. **Where should `quick-actions.ts` live?**
   - Options: (a) `$lib/quick-actions.ts`, (b) `$lib/components/quick-actions.ts`, (c) `$lib/state/quick-actions.ts`
   - **Recommendation**: `$lib/quick-actions.ts`. It's not a component, not reactive state. It's a registry of action definitions. Top-level lib is fine.

3. **Should the `whenReady` block survive at all?**
   - After removing awareness and command consumer, the only thing left might be nothing (or device table registration if that happens there)
   - **Recommendation**: Check if device registration (`devices.set(...)`) happens in `whenReady`. If yes, keep the block with just that. If not, remove the entire `whenReady` block.

4. **Should we remove the `commands/` reference from `specs/20260223T200500-ai-tools-command-queue.md`?**
   - **Recommendation**: No. Specs are historical records. Add a note at the top: `**Status**: Superseded: commands table removed in [this spec]`.

## Success Criteria

- [x] `$lib/commands/` directory no longer exists
- [x] `commandsTable`, `commandBase`, `CommandId`, `Command` type are gone from `workspace.ts`
- [x] `awareness` config is gone from `defineWorkspace` call
- [x] `startCommandConsumer` call is gone from `whenReady` block
- [x] `tab-actions.ts` exists with all 8 execute functions + `nativeTabId` helper
- [x] `quick-actions.ts` exists at its new location with updated import in `CommandPalette.svelte`
- [x] `.withActions()` mutation handlers still reference execute functions via new import path
- [x] `bun run check` passes with zero errors (in tab-manager src; pre-existing UI package errors unrelated)
- [x] AI chat can still call tools (search, close, open, etc.) on the current device
- [x] Command palette still opens and quick actions still execute

## References

- `apps/tab-manager/src/lib/workspace.ts`: Main file: commands table, awareness, whenReady block
- `apps/tab-manager/src/lib/commands/actions.ts`: Execute functions to relocate
- `apps/tab-manager/src/lib/commands/consumer.ts`: Command consumer to delete
- `apps/tab-manager/src/lib/commands/constants.ts`: TTL constant to delete
- `apps/tab-manager/src/lib/commands/quick-actions.ts`: Command palette actions to relocate
- `apps/tab-manager/src/lib/components/CommandPalette.svelte`: Imports quick-actions
- `apps/tab-manager/src/lib/state/chat-state.svelte.ts`: AI chat (verify no regression)
- `specs/20260223T200500-ai-tools-command-queue.md`: Original spec that introduced commands
- `specs/20251213T231125-multi-device-tab-sync.md`: Multi-device sync spec (context)
- `packages/workspace/src/workspace/create-awareness.ts`: Awareness implementation (NOT touched. This is workspace-level, stays)

## Review

**Completed**: 2026-03-11

### Summary

Removed the commands table, command consumer, awareness config, and whenReady block from the tab-manager workspace. Relocated execute functions to `$lib/tab-actions.ts` and quick actions to `$lib/quick-actions.ts`. The `.withActions()` mutation handlers and AI chat tool calling are functionally unchanged. They now import from the new paths.

### Deviations from Spec

- The `whenReady` block was removed entirely (not just simplified) because after removing awareness.setLocal() and startCommandConsumer(), only an unused `getDeviceId()` call remained. No device registration happens there: `getDeviceId()` is called per-action in the mutation handlers instead.

### Files Changed

- **Created**: `apps/tab-manager/src/lib/tab-actions.ts` (8 execute functions + nativeTabId helper)
- **Created**: `apps/tab-manager/src/lib/quick-actions.ts` (command palette action registry)
- **Modified**: `apps/tab-manager/src/lib/workspace.ts` (removed commands table, CommandId, commandBase, awareness, whenReady block; updated imports)
- **Modified**: `apps/tab-manager/src/lib/components/CommandPalette.svelte` (updated quick-actions import path)
- **Deleted**: `apps/tab-manager/src/lib/commands/` (actions.ts, constants.ts, consumer.ts, quick-actions.ts)
