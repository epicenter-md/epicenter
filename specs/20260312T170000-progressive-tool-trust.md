# Progressive Tool Trust & Approval Cleanup

**Date**: 2026-03-12
**Status**: Implemented
**Author**: AI-assisted

## Overview

Replace the blanket `requireApprovalForMutations` option with a progressive trust model: destructive tools start with an inline approval gate in the chat, and users can escalate to "always allow" per-action. Clean up the redundant approval mechanisms introduced across the previous spec.

## Motivation

### Current State

Three overlapping mechanisms control tool approval:

```typescript
// 1. Blanket option on the tool bridge (UNUSED — nobody passes true)
actionsToClientTools(actions, { requireApprovalForMutations: true });

// 2. Per-action `destructive` flag (just added)
defineMutation({ destructive: true, ... });

// 3. System prompt telling the AI to "confirm with user if count > 5"
"When closing or modifying multiple tabs, confirm with the user if the count is large (>5)"
```

Meanwhile, quick actions already have a clean destructive flow:

```typescript
// quick-actions.ts — dangerous flag → confirmationDialog
const dedupAction: QuickAction = {
  dangerous: true,
  execute() {
    confirmationDialog.open({
      title: 'Remove Duplicate Tabs',
      confirm: { text: 'Close Duplicates', variant: 'destructive' },
      onConfirm: async () => { ... },
    });
  },
};
```

But the AI chat has **no approval UI at all**. Tools auto-execute immediately — `ToolCallPart.svelte` shows a spinner, then a result. No gate, no confirmation, nothing.

This creates problems:

1. **`requireApprovalForMutations` is dead code** — nobody passes it, and now that `destructive` exists it's redundant
2. **`needsApproval` is always set** — the tool bridge currently sets `needsApproval: false` on non-destructive tools instead of omitting it, which sends unnecessary data over the wire
3. **No approval UI in chat** — even though `destructive` flows to `needsApproval` on the wire, the client never acts on it. TanStack AI's `ChatClient` has a `client.approve(toolCallId)` method that's never called
4. **Two confirmation systems** — quick actions use `confirmationDialog`; the AI chat will need inline approval. These should share the trust concept but use different UI

### Desired State

```
┌─────────────────────────────────────────────────────────────┐
│  Action Definition                                          │
│  defineMutation({ destructive: true, ... })                 │
│           │                                                 │
│           ▼                                                 │
│  Tool Bridge                                                │
│  needsApproval: action.destructive  (only when true)        │
│           │                                                 │
│           ├──► Server: APPROVAL_REQUESTED event              │
│           │                                                 │
│           ▼                                                 │
│  ChatClient pauses, ToolCallPart renders approval UI        │
│           │                                                 │
│           ├── User clicks [Allow]  → client.approve(id)     │
│           ├── User clicks [Always Allow] → persist + approve │
│           └── User clicks [Deny]  → client.deny(id)         │
│                                                             │
│  Trust State (localStorage)                                 │
│  { "tabs_close": "always" }                                 │
│  → Next time: auto-approve, show subtle ✅ indicator        │
└─────────────────────────────────────────────────────────────┘
```

## Research Findings

### TanStack AI Approval API (Phase 3 Research — Confirmed)

TanStack AI's `ChatClient` has built-in approval support. Verified from source:

- **Server-side**: `chat()` automatically checks `needsApproval` on tool definitions and emits a `CUSTOM` SSE event named `approval-requested`. No server code changes needed — `apps/api/src/ai-chat.ts` already passes tools through to `chat()`.
- **`chatClient.addToolApprovalResponse({ id, approved })`** — the approval method. `id` is `part.approval.id` (not `toolCallId`), `approved` is `true`/`false`.
- **`ToolCallPart.state`** — possible values include `'approval-requested'` (waiting for user) and `'approval-responded'` (user acted).
- **`ToolCallPart.approval`** — object with `{ id: string, needsApproval: boolean, approved?: boolean }`. `approved` is `undefined` while pending.

**Corrected flow**: LLM calls tool → server detects `needsApproval` → emits `CUSTOM` `approval-requested` SSE event → `ChatClient` updates `part.state` to `'approval-requested'` → UI renders approve/deny → user acts → `addToolApprovalResponse({ id: part.approval.id, approved })` → server resumes or denies.

**Key finding**: Full infrastructure exists end-to-end. No server changes needed. Phase 4 only needs UI wiring.

### Industry Patterns

| Product | Approval Model | Progressive Trust? |
|---|---|---|
| Claude Desktop (MCP) | "Allow for This Chat" / "Always Allow" per-tool | Yes — two levels |
| Cursor | Inline approve for terminal, auto-approve for edits | Partial — yolo mode |
| OpenCode | Inline approve/deny in chat thread | No — per-invocation |
| ChatGPT Actions | "Always allow [domain]" on first use | Yes — per-domain |

**Key finding**: "Always Allow" per-tool is the standard pattern. No product does "approve N times then escalate" — it's always a one-click trust decision.

**Implication**: Two trust levels is the right model: `ask` (show approval UI) and `always` (auto-approve with indicator).

### Existing Codebase Patterns

| System | Dangerous Flag | Approval UI | Trust State |
|---|---|---|---|
| Quick Actions | `dangerous: true` | `confirmationDialog` (modal) | None (always asks) |
| AI Tool Calls | `destructive: true` | None (auto-executes) | None |
| System Prompt | "confirm if count > 5" | AI asks in prose | None |

**Key finding**: The confirmation dialog is wrong for chat context — it breaks conversation flow. Inline approval is the right pattern for streaming chat.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Remove `requireApprovalForMutations` | Remove entirely | Unused, redundant with `destructive`, approval fatigue |
| `needsApproval` conditional | Only set when `true` | Avoids sending `needsApproval: false` for every tool |
| Approval UI location | Inline in `ToolCallPart.svelte` | Maintains conversation flow; matches Cursor/Claude patterns |
| Trust persistence | Workspace table (`toolTrustTable`) | CRDT-backed, syncs across devices, follows existing workspace data pattern |
| Trust levels | `ask` / `always` (2 levels) | Matches industry standard; no unnecessary complexity |
| Trust scope | Per-action name, not per-session | "Always Allow" means always, across conversations |
| Trust revocation | Settings page toggle | Not in the approval UI itself — too easy to misclick |
| Non-destructive tools | No approval ever | Queries and safe mutations auto-execute always |

## Architecture

### Trust State

```typescript
// $lib/state/tool-trust.svelte.ts
type TrustLevel = 'ask' | 'always';

// Backed by workspace table (toolTrustTable in workspace.ts)
// CRDT-synced across devices — non-destructive tools are implicitly 'always'
```

### Approval Flow

```
User sends message
        │
        ▼
Server processes, LLM calls tool
        │
        ▼
Server checks needsApproval on tool definition
        │
        ├── false/absent → TOOL_CALL event → ChatClient auto-executes
        │
        └── true → APPROVAL_REQUESTED event → ChatClient pauses
                        │
                        ▼
              ToolCallPart renders approval UI
                        │
                        ▼
              Check trust state for this tool name
                        │
                        ├── 'always' → auto-approve immediately
                        │              (show subtle ✅ indicator)
                        │
                        └── 'ask' → show [Allow] [Always Allow] [Deny]
                                        │
                                        ├── Allow → client.approve(id)
                                        ├── Always Allow → persist trust + approve
                                        └── Deny → client.deny(id) or stop
```

### ToolCallPart UI States

```
┌─────────────────────────────────────────────────────┐
│  State: APPROVAL_REQUESTED (untrusted)              │
│                                                     │
│  🔴 Close Tabs                                      │
│  Arguments: { tabIds: ["abc_1", "abc_2", "abc_3"] } │
│                                                     │
│  ┌─────────┐ ┌───────────────┐ ┌──────┐           │
│  │  Allow  │ │ Always Allow  │ │ Deny │           │
│  └─────────┘ └───────────────┘ └──────┘           │
├─────────────────────────────────────────────────────┤
│  State: APPROVAL_REQUESTED (auto-approved)          │
│                                                     │
│  ⏳ Close Tabs (auto-approved)                      │
│     └─ Details                                      │
├─────────────────────────────────────────────────────┤
│  State: RUNNING                                     │
│                                                     │
│  ⏳ Close Tabs…                                     │
│     └─ Details                                      │
├─────────────────────────────────────────────────────┤
│  State: COMPLETED                                   │
│                                                     │
│  ✅ Close Tabs                                      │
│     └─ Details                                      │
├─────────────────────────────────────────────────────┤
│  State: DENIED                                      │
│                                                     │
│  ⛔ Close Tabs — denied                             │
│     └─ Details                                      │
└─────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Cleanup — Remove `requireApprovalForMutations`

- [x] **1.1** Remove `requireApprovalForMutations` option from `actionsToClientTools` in `packages/ai/src/tool-bridge.ts`
- [x] **1.2** Change `needsApproval` to only be set when `action.destructive` is truthy (conditional spread, not always-set)
- [x] **1.3** In `toToolDefinitions`, only forward `needsApproval` when truthy (match the conditional pattern)
- [x] **1.4** Update `tool-bridge.test.ts` — remove the `requireApprovalForMutations` test, keep the `destructive → needsApproval` test, add a test that non-destructive tools omit `needsApproval`
- [x] **1.5** Update the `ToolDefinitionPayload` JSDoc to reflect the simplified model
- [x] **1.6** Remove the `requireApprovalForMutations` mentions from the previous spec's review section

### Phase 2: Trust State

- [x] **2.1** Create `apps/tab-manager/src/lib/state/tool-trust.svelte.ts` — reactive trust state backed by workspace table
  > **Deviation**: Changed from localStorage to a `defineTable`-backed workspace table (`toolTrustTable` in `workspace.ts`). This gives per-row CRDT merging across devices and follows the existing workspace data pattern. The table is defined in `apps/tab-manager/src/lib/workspace.ts`.
- [x] **2.2** Export `getToolTrust(name: string): TrustLevel`, `setToolTrust(name: string, level: TrustLevel)`, and `toolTrustState` (reactive SvelteMap synced via `.observe()`)
- [x] **2.3** Default: all tools are implicitly `'ask'` unless the user has explicitly trusted them via `setToolTrust`

### Phase 3: Investigate TanStack AI Approval Integration

- [x] **3.1** Research how TanStack AI's ChatClient signals approval state — confirmed `part.state === 'approval-requested'` and `part.approval` object
- [x] **3.2** Research how to call approval — confirmed: `chatClient.addToolApprovalResponse({ id: part.approval.id, approved: boolean })`
- [x] **3.3** Research whether the server needs changes — **No changes needed.** `chat()` auto-handles `needsApproval` and emits `approval-requested` SSE events
- [x] **3.4** Document findings and update this spec before proceeding to Phase 4

### Phase 4: Inline Approval UI

- [x] **4.1** Update `ToolCallPart.svelte` to detect `part.state === 'approval-requested'`
- [x] **4.2** When approval-requested AND trust is `'ask'`: render inline [Allow] [Always Allow] [Deny] buttons
- [x] **4.3** When approval-requested AND trust is `'always'`: auto-approve immediately via `$effect`, show subtle "Auto-approved" indicator
- [x] **4.4** Wire [Allow] to `aiChatState.active?.approveToolCall(approval.id, true)`
- [x] **4.5** Wire [Always Allow] to `setToolTrust(name, 'always')` + `approveToolCall`
- [x] **4.6** Wire [Deny] to `aiChatState.active?.approveToolCall(approval.id, false)`
- [x] **4.7** Style the approval UI — ShieldAlert/ShieldCheck icons, outline/ghost buttons, amber/green colors
- [x] **4.8** Expose `approveToolCall` from chat-state via `ConversationHandle` — delegates to `client.addToolApprovalResponse`

### Phase 5: Verification

- [x] **5.1** `bun typecheck` passes (pre-existing failures only: `NumberKeysOf` in define-table.ts, `#/utils.js` in UI package)
- [x] **5.2** `bun test` passes — tool-bridge (4/4), describe-workspace (9/9)
- [x] **5.3** Manual test: destructive tool in chat shows approval UI
- [x] **5.4** Manual test: "Always Allow" persists across conversations
- [x] **5.5** Manual test: non-destructive tools auto-execute without approval
## Edge Cases

### Trust state and new destructive actions

1. Developer adds a new `destructive: true` action
2. User has never seen it → no trust entry in the workspace table
3. Default behavior: show approval UI (`'ask'`)
4. This is correct — new destructive actions are untrusted by default

### Workspace data reset

1. User resets their workspace or starts fresh
2. All trust entries are lost (part of the Y.Doc)
3. Destructive actions revert to `'ask'`
4. This is acceptable — re-trusting is low friction

### Multiple destructive tool calls in one response

1. AI calls `tabs.close` three times in one response (e.g. closing tabs from different windows)
2. If trust is `'ask'`: show approval for each tool call independently
3. If trust is `'always'`: auto-approve all three
4. No "approve all" batch button — keep it simple for now

### Server doesn't support APPROVAL_REQUESTED

1. If the API server's `chat()` handler doesn't use TanStack AI's `executeToolCalls` with approval support, the server might just send `TOOL_CALL` events regardless of `needsApproval`
2. Phase 3 research will determine this
3. If the server doesn't support it, we either: (a) add server support, or (b) implement client-side approval interception (intercept the tool execution in `ChatClient.tools[name].execute()` before it runs)

## Open Questions

1. **Does the API server support `APPROVAL_REQUESTED`?**
   - The server at `apps/api/src/` has no grep hits for `needsApproval`, `approval`, or `executeToolCalls`
   - Phase 3 will investigate whether `chat()` from TanStack AI automatically handles this
   - **Recommendation**: If not, client-side interception is simpler — wrap `execute` functions with a trust gate

2. **Should "Always Allow" persist across extension updates?**
   - Workspace table data persists via IndexedDB and Y.Doc sync
   - **Resolved**: Yes. Trust is stored in the workspace table, which survives updates and syncs across devices

3. **Should there be a UI to revoke trust?**
   - Users who click "Always Allow" may want to undo it
   - **Recommendation**: Add a simple list in settings (later spec). For now, the workspace table can be queried directly

4. **What about the system prompt "confirm if count > 5" guideline?**
   - The system prompt tells the AI to confirm large operations in prose
   - With proper approval UI, this is redundant — the UI handles it
   - **Recommendation**: Remove that guideline from the system prompt in Phase 1, or defer to a later cleanup

## Success Criteria

- [x] `requireApprovalForMutations` is fully removed from the codebase
- [x] `needsApproval` is only set on tools with `destructive: true`
- [x] Destructive tool calls in chat show inline approval UI (or auto-approve if trusted)
- [x] Non-destructive tool calls execute immediately without any approval gate
- [x] "Always Allow" persists across conversations and page reloads
- [x] All existing tests pass with no regressions
## References

- `packages/ai/src/tool-bridge.ts` — `actionsToClientTools`, `toToolDefinitions`, `needsApproval` logic
- `packages/ai/src/tool-bridge.test.ts` — Tests for destructive → needsApproval mapping
- `packages/workspace/src/shared/actions.ts` — `ActionConfig.destructive` definition
- `apps/tab-manager/src/lib/workspace.ts` — All 13 action definitions with `destructive: true` on `tabs.close`
- `apps/tab-manager/src/lib/components/chat/ToolCallPart.svelte` — Current tool call rendering (no approval UI)
- `apps/tab-manager/src/lib/state/chat-state.svelte.ts` — `ChatClient` setup, `workspaceTools` passed as client tools
- `apps/tab-manager/src/lib/quick-actions.ts` — Existing `dangerous` flag pattern with `confirmationDialog`
- `packages/ui/src/confirmation-dialog/` — Existing confirmation dialog (for reference, not for reuse in chat)
- `apps/tab-manager/src/lib/ai/system-prompt.ts` — "confirm if count > 5" guideline to potentially remove
- `specs/20260312T153000-action-metadata-title-destructive.md` — Previous spec that added `destructive`
