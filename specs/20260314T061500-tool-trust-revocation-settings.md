# Tool Trust Revocation Settings

**Date**: 2026-03-14
**Status**: Implemented
**Author**: AI-assisted

## Overview

Add a settings panel inside the AI chat drawer where users can view all tools they've marked as "Always Allow" and revoke that trust. Currently there is no way to undo an "Always Allow" decision without directly editing the workspace's Y.Doc.

## Motivation

### Current State

When a destructive tool call arrives, `ToolCallPart.svelte` shows [Allow] / [Always Allow] / [Deny]. Clicking "Always Allow" writes to the workspace table and auto-approves all future calls for that tool:

```typescript
// ToolCallPart.svelte — "Always Allow" handler
function handleAlwaysAllow() {
  if (!approval?.id) return;
  toolTrustState.set(part.name, 'always');
  aiChatState.active?.approveToolCall(approval.id, true);
}
```

The trust state module has `get()` and `set()` but no way to list or revoke:

```typescript
// tool-trust.svelte.ts — current API surface
return {
  get(name: string): TrustLevel { ... },
  set(name: string, level: TrustLevel): void { ... },
  shouldAutoApprove(name: string): boolean { ... },
};
```

This creates problems:

1. **No revocation path**: Once a user clicks "Always Allow", the only way to undo it is to clear workspace data or manually edit the Y.Doc. There is no UI to list or toggle trust decisions.
2. **No visibility**: Users cannot see which tools they've trusted. The trust map is hidden inside a `SvelteMap` with no enumeration exposed to consumers.
3. **Accidental trust**: A misclick on "Always Allow" is permanent with no recourse.

### Desired State

A small settings section inside the AI chat drawer that lists all trusted tools with a Switch toggle to revoke each one. The trust state module exposes `entries()` for enumeration and `revoke()` for single-tool removal.

## Research Findings

### Existing UI Patterns in Tab Manager

| Component | Pattern | Location |
|---|---|---|
| `SyncStatusIndicator` | Popover from header icon with auth form + status | `components/SyncStatusIndicator.svelte` |
| `AiDrawer` | Bottom Drawer with header, gated on auth | `components/AiDrawer.svelte` |
| `CommandPalette` | Command dialog overlay | `components/CommandPalette.svelte` |
| `ToolCallPart` | Inline approval buttons in chat stream | `components/chat/ToolCallPart.svelte` |

**Key finding**: The app has no settings page. Configuration surfaces are embedded in context—sync settings live in the SyncStatusIndicator popover, AI chat lives in the AiDrawer. Trust settings should follow this pattern: embedded in the AI context, not a separate page.

### Available shadcn-svelte Components

Components already in `@epicenter/ui/` that are relevant:

| Component | Import | Used In Tab Manager? |
|---|---|---|
| `Switch` | `@epicenter/ui/switch` | No (exists in `packages/ui/src/switch/`) |
| `Button` | `@epicenter/ui/button` | Yes (everywhere) |
| `Popover` | `@epicenter/ui/popover` | Yes (SyncStatusIndicator, comboboxes) |
| `Drawer` | `@epicenter/ui/drawer` | Yes (AiDrawer) |
| `Badge` | `@epicenter/ui/badge` | Yes (ToolCallPart) |
| `Collapsible` | `@epicenter/ui/collapsible` | Yes (CollapsibleSection) |
| `Tooltip` | `@epicenter/ui/tooltip` | Yes (App.svelte header) |

**Key finding**: `Switch` component exists in the UI package but hasn't been used in tab-manager yet. It's the natural fit for a trust toggle. No need to add new shadcn components.

### Trust State Surface Area

The `toolTrustTable` workspace table stores trust rows:

```typescript
// workspace.ts — table definition
const toolTrustTable = defineTable({
  id: Type.String(),      // tool name (e.g. "tabs_close")
  trust: Type.String(),   // 'ask' | 'always'
  _v: Type.Number(),
});
```

Internal `readAllTrust()` already builds a `Map<string, TrustLevel>` from `workspaceClient.tables.toolTrust.getAllValid()`. It just isn't exposed.

### Industry Patterns

| Product | Trust Revocation UI |
|---|---|
| Claude Desktop (MCP) | Settings → "Integrations" lists all tools with permission toggles |
| ChatGPT | Settings → "Connected apps" with per-app revoke |
| Cursor | Settings panel → "Features" → yolo mode toggle (global, not per-tool) |

**Key finding**: Every product that has per-tool trust puts revocation in a settings surface, not in the chat stream. A small list with toggles is the standard.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Settings location | Gear icon in AiDrawer header → Popover | Trust is AI-chat-specific. Follows SyncStatusIndicator pattern (icon → popover). Doesn't add a new top-level UI surface. |
| Toggle component | `Switch` from `@epicenter/ui/switch` | Standard on/off toggle. Already in the UI package. |
| Trust display | Tool title + Switch per row | Simple, scannable. Matches Claude Desktop pattern. |
| Revocation method | `set(name, 'ask')` (not delete) | Consistent with existing API. Row stays in table with `'ask'` value. Avoids needing a delete method on the table. |
| Empty state | Hide gear icon when no tools are trusted | No point showing settings when there's nothing to configure. |
| API additions | `entries()` on `toolTrustState` | Returns reactive `Map<string, TrustLevel>` for the UI to iterate. Minimal surface addition. |
| Tool name display | Reuse `workspaceToolTitles` lookup | Already maps tool names to human-readable titles (e.g. `tabs_close` → "Close Tabs"). |

## Architecture

```
AiDrawer.svelte
┌──────────────────────────────────────────────────────┐
│  Drawer.Header                                        │
│  ┌──────────────────────────┐  ┌──────────────────┐  │
│  │ "AI Chat"                │  │ ⚙ (gear icon)    │  │
│  └──────────────────────────┘  └────────┬─────────┘  │
│                                         │             │
│                                    Popover.Content    │
│                              ┌─────────────────────┐  │
│                              │ Tool Permissions     │  │
│                              │                     │  │
│                              │ Close Tabs   [====] │  │
│                              │ (future...)  [====] │  │
│                              │                     │  │
│                              │ ─────────────────── │  │
│                              │ Revoke All (link)   │  │
│                              └─────────────────────┘  │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │ AiChat                                            │ │
│  │ (existing chat UI)                                │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### Trust Flow (Revocation)

```
User clicks gear icon in AiDrawer header
        │
        ▼
Popover opens, showing trusted tools
(entries from toolTrustState.entries() where trust === 'always')
        │
        ▼
User toggles Switch OFF for "Close Tabs"
        │
        ▼
toolTrustState.set('tabs_close', 'ask')
        │
        ▼
Y.Doc observer fires → SvelteMap updates → Switch reactively flips
        │
        ▼
Next "Close Tabs" tool call shows [Allow] / [Always Allow] / [Deny] again
```

## Implementation Plan

### Phase 1: Extend Trust State API

- [x] **1.1** Add `entries()` method to `toolTrustState` in `apps/tab-manager/src/lib/state/tool-trust.svelte.ts` — return the internal `trustMap` (already a `SvelteMap`, already reactive)
- [x] **1.2** Verify reactivity: when `set()` is called elsewhere (e.g. ToolCallPart "Always Allow"), the Popover's list should update live via the Y.Doc observer

### Phase 2: Settings Popover Component

- [x] **2.1** Create `apps/tab-manager/src/lib/components/chat/TrustSettings.svelte` — self-contained Popover component
- [x] **2.2** Import `Switch` from `@epicenter/ui/switch`, `Button` from `@epicenter/ui/button`, `Popover` from `@epicenter/ui/popover`
- [x] **2.3** Import `toolTrustState` and `workspaceToolTitles` for data and display names
- [x] **2.4** List only tools where trust is `'always'` (no point showing `'ask'` tools — they're the default)
- [x] **2.5** Each row: tool title (from `workspaceToolTitles`) + `Switch` bound to whether trust is `'always'`
- [x] **2.6** Toggling Switch OFF calls `toolTrustState.set(name, 'ask')`
- [x] **2.7** Empty state: hide gear icon when no tools are trusted (Option B from Open Questions)
- [x] **2.8** Optional: "Revoke All" text button at the bottom that sets all entries to `'ask'` (shown when 2+ tools trusted)

### Phase 3: Wire Into AiDrawer

- [x] **3.1** Add gear icon (`SettingsIcon` from `@lucide/svelte/icons/settings`) to `AiDrawer.svelte` header, next to the title
- [x] **3.2** Only show gear icon when there is at least one trusted tool (check `toolTrustState.entries()` size)
- [x] **3.3** Render `<TrustSettings />` inside the drawer (it manages its own Popover state)

### Phase 4: Verification

- [x] **4.1** `bun run typecheck` passes (0 errors in changed files; 89 pre-existing errors in UI package unrelated)
- [ ] **4.2** Manual test: trust a tool via "Always Allow" → gear icon appears → popover shows the tool → toggle off → next tool call asks for approval again
- [ ] **4.3** Manual test: "Revoke All" resets all trusted tools
- [ ] **4.4** Manual test: empty state shows when no tools are trusted

## Edge Cases

### Trust changed from another device

1. User trusts "Close Tabs" on Device A
2. User revokes it in the settings popover on Device B
3. Y.Doc CRDT syncs the change → Device A's trust map updates via the existing `.observe()` callback
4. Next "Close Tabs" call on Device A shows approval UI again
5. **No special handling needed** — the existing observer pattern handles this

### All tools revoked

1. User clicks "Revoke All"
2. All entries set to `'ask'`
3. Gear icon hides (no trusted tools)
4. Popover closes (or stays open showing empty state — implementer decides)

### Tool renamed or removed

1. Developer renames a workspace action (e.g. `tabs_close` → `tabs_remove`)
2. Old trust entry for `tabs_close` still in the table
3. It won't match any tool, so it's harmless — shows in settings as an unknown tool
4. **Recommendation**: Show the raw tool name as fallback when `workspaceToolTitles[name]` is undefined. No cleanup logic needed.

## Open Questions

1. **Should the gear icon always be visible, or only when tools are trusted?**
   - Option A: Always visible (settings are discoverable even before trusting anything)
   - Option B: Only visible when ≥1 tool is trusted (cleaner header, less visual noise)
   - **Recommendation**: Option B. The header is already compact. Trust settings aren't useful until you've actually trusted something. But the implementer may discover a better placement during implementation.

2. **Should "Revoke All" require confirmation?**
   - It's a bulk action but low-stakes (just resets to the default state)
   - **Recommendation**: No confirmation. Revoking trust isn't destructive — it just means the next tool call will ask again.

3. **Should the popover be a separate component or part of a larger settings surface?**
   - Currently no settings page exists. This would be the first settings UI.
   - **Recommendation**: Keep it as a focused popover for now. If more AI settings emerge later (model preferences, conversation defaults), consider extracting to a full settings panel at that point.

## Success Criteria

- [x] `toolTrustState` exposes `entries()` returning a reactive iterable of trusted tools
- [x] `TrustSettings.svelte` renders a list of trusted tools with Switch toggles
- [x] Toggling a Switch revokes trust and the tool asks for approval on next use
- [x] Gear icon in AiDrawer header opens the settings popover
- [x] Empty state handled (no trusted tools → gear icon hides)
- [x] `bun run typecheck` passes (changed files clean)
- [x] No `as any` or `@ts-ignore` introduced

## References

- `apps/tab-manager/src/lib/state/tool-trust.svelte.ts` — Trust state module to extend with `entries()`
- `apps/tab-manager/src/lib/components/chat/ToolCallPart.svelte` — Existing "Always Allow" handler (consumer of trust state)
- `apps/tab-manager/src/lib/components/AiDrawer.svelte` — Where the gear icon will be added
- `apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte` — Reference pattern for Popover-from-icon-button
- `apps/tab-manager/src/lib/workspace.ts` — `workspaceToolTitles` lookup map, `toolTrustTable` definition
- `packages/ui/src/switch/` — Switch component (exists, not yet used in tab-manager)
- `packages/ui/src/popover/` — Popover component (already used in tab-manager)
- `specs/20260312T170000-progressive-tool-trust.md` — Parent spec that introduced the trust system

## Review

**Completed**: 2026-03-14

### Summary

Added a settings popover in the AI chat drawer for viewing and revoking tool trust decisions. Three files changed:

1. **tool-trust.svelte.ts** (+19 lines): Added `entries()` method returning the internal `SvelteMap` for reactive enumeration.
2. **TrustSettings.svelte** (59 lines, new): Self-contained Popover component with gear icon trigger, Switch toggles per trusted tool, and "Revoke All" button (shown when 2+ tools trusted). Hides entirely when no tools are trusted.
3. **AiDrawer.svelte** (+4 lines): Imported TrustSettings, added flex wrapper in header to position gear icon next to title.

### Deviations from Spec

- **2.7 Empty state**: Chose Option B (hide gear icon) rather than showing an in-popover "No tools trusted" message. When the last tool is revoked, the component unmounts cleanly.
- **2.8 Revoke All**: Made visible only when 2+ tools are trusted (not always). With a single tool, the user can just toggle the Switch directly.
- **Button import omitted**: TrustSettings uses `buttonVariants` for the trigger but doesn't need the `Button` component itself. Kept imports minimal.

### Follow-up Work

- Manual testing needed (spec items 4.2–4.4) to verify end-to-end flow in the extension.
