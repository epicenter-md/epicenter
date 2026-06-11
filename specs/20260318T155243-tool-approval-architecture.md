# Tool Approval Architecture: Clone Workaround vs Approval-in-Execute

**Date**: 2026-03-18
**Status**: Draft
**Author**: AI-assisted
**Depends on**: `specs/20260313T080000-chat-architecture-redesign.md`

## Overview

Tool calls requiring user approval (mutations like "Open Tab", "Close Tab") are stuck in a permanent spinner. The root cause is TanStack AI's StreamProcessor mutating tool-call part objects in place after `onMessagesChange` fires, bypassing Svelte 5's `$state` proxy. This spec evaluates two architectural approaches: a targeted clone workaround (already implemented) and a fundamentally different "approval-in-execute" pattern that sidesteps the mutation problem entirely.

## Motivation

### Current State

TanStack AI's `updateToolCallApproval` in `message-updaters.ts` (lines 147-158):

```typescript
const parts = [...msg.parts]           // new array, SAME part objects
const toolCallPart = parts.find(...)   // finds the SAME object reference
toolCallPart.state = 'approval-requested'  // MUTATES IN PLACE
toolCallPart.approval = { id: approvalId, needsApproval: true }
return { ...msg, parts }               // new message, new array, SAME mutated part
```

The spread creates a new message and a new parts array, but the tool-call part inside is the same object. When `onMessagesChange` fires with this array, Svelte 5 wraps it in a proxy. But the mutations already happened on the original object, not through the proxy. `$derived(part.state === 'approval-requested')` never re-evaluates.

This creates three problems:

1. **Approval buttons never render**: `isApprovalRequested` stays `false`, the spinner shows forever, the tool never executes
2. **`createChat` from `@tanstack/ai-svelte` can't fix this**: It wraps `ChatClient` but doesn't expose `onMessagesChange` for interception: we can't add cloning
3. **The problem is structural**: Every `update*` function in `message-updaters.ts` follows the same pattern: new arrays, same part objects, in-place property mutations

### Desired State

Tool calls requiring approval show Allow/Always Allow/Deny buttons immediately. The architecture should not depend on detecting in-place mutations on objects we don't control.

## Research Findings

### TanStack AI's Mutation Model (verified against latest `main`, pulled 2026-03-18)

| Function | Creates new part? | Mutates in place? | Fixed in PR #352? |
|---|---|---|---|
| `updateToolCallPart` | **Yes**: creates new `ToolCallPart` object | No (after PR #352) | ✅ |
| `updateToolCallApproval` | No: finds existing part, mutates `.state` and `.approval` | **Yes** | ❌ |
| `updateToolCallState` | No: finds existing part, mutates `.state` | **Yes** | ❌ |
| `updateToolCallWithOutput` | No: finds existing part, mutates `.output` and `.state` | **Yes** | ❌ |
| `updateToolCallApprovalResponse` | No: finds existing part, mutates `.approval.approved` and `.state` | **Yes** | ❌ |

**Key finding**: PR #352 (`2ee0b333`, 2026-03-09) fixed `updateToolCallPart` to create new objects, but 4 out of 5 update functions still mutate in place. The in-place pattern is pervasive, not a single oversight.

**Implication**: Relying on `part.state` for reactivity will continue to require workarounds until TanStack AI changes all update functions. This is alpha-stage software: the mutation model may or may not change.

### Svelte 5 Reactivity and External Mutations

| Mechanism | Detects in-place mutations on raw objects? | Notes |
|---|---|---|
| `$state` (deep proxy) | Only if mutations go through the proxy | StreamProcessor writes to raw object, bypasses proxy |
| `$state.raw` (no proxy) | No: requires new reference to trigger | Same problem, different flavor |
| `$derived` | Re-evaluates when dependencies change | Dependency on `part.state` never fires if proxy is bypassed |
| Version counter + getter | Forces getter re-evaluation | But `{#each}` with keyed items skips re-render if item reference is same |
| Clone | Creates new references Svelte can track | **Only mechanism that works** |

**Key finding**: There is no Svelte 5 API that detects mutations made to an object behind a proxy's back. The proxy pattern is fundamentally one-directional: it intercepts reads/writes through the proxy, not writes to the underlying object.

### TanStack AI's Event System

ChatClient emits events through `aiEventClient` (a global `EventClient` from `@tanstack/devtools-event-client`):

```
tools:approval:requested : fires when StreamProcessor sets approval state
tools:result:added       : fires when tool result is added
tools:call:updated       : fires on tool-call state changes
```

These events carry full metadata (`toolCallId`, `toolName`, `approvalId`, etc.) and fire at the exact moments we need to update the UI. However, `@tanstack/ai-event-client` is a devtools package: using it for production logic couples us to a telemetry API.

### ChatClient Tool Execution Flow

```
Server streams tool-call chunk
        │
        ▼
StreamProcessor receives it
        │
        ├─── chunk.name === 'tool-input-available'
        │    (tool does NOT need approval)
        │    │
        │    ▼
        │    Fires onToolCall event
        │    │
        │    ▼
        │    ChatClient calls execute(args.input)
        │    │
        │    ▼
        │    Tracks in pendingToolExecutions Map
        │    │
        │    ▼
        │    After execute resolves: addToolResult()
        │
        └─── chunk.name === 'approval-requested'
             (tool has needsApproval: true)
             │
             ▼
             Calls updateToolCallApproval() ← MUTATES IN PLACE
             │
             ▼
             Fires emitMessagesChange()
             │
             ▼
             Fires onApprovalRequest event
             │
             ▼
             UI should show approval buttons (BROKEN)
```

**Key finding**: The server's `chat()` function decides whether to send `tool-input-available` or `approval-requested` based on the `needsApproval` field in the tool definition. If we remove `needsApproval`, the server always sends `tool-input-available`, and the ChatClient calls `execute()` directly.

## Design Options

### Option A: Targeted Clone (Current Implementation)

Keep direct `ChatClient`. Clone only tool-call parts in `onMessagesChange`, `queueMicrotask`, and `onStatusChange`.

```
onMessagesChange(msgs)
    │
    ▼
Clone tool-call parts → new object references
    │
    ▼
queueMicrotask → clone AGAIN (catches deferred mutations)
    │
    ▼
Svelte wraps new objects in fresh proxies
    │
    ▼
$derived(part.state === 'approval-requested') → detects correctly ✓
```

### Option B: Approval-in-Execute

Remove `needsApproval` from tool definitions. Handle approval inside the tool's `execute` function by awaiting a user decision before running the action.

```
Server sends tool-input-available (no approval event)
    │
    ▼
ChatClient calls execute(args.input)
    │
    ▼
execute() checks: is this a mutation?
    │
    ├── No → run action immediately, return result
    │
    └── Yes → add to pendingApprovals $state Map
              │
              ▼
              await Promise (user hasn't decided yet)
              │
              ▼
              UI reads pendingApprovals Map (OUR $state, Svelte tracks it)
              │
              ├── User clicks Allow → resolve Promise → run action → return result
              └── User clicks Deny → resolve Promise → return { error: 'denied' }
```

### Comparison

| Dimension | Option A: Targeted Clone | Option B: Approval-in-Execute |
|---|---|---|
| **Works today?** | ✅ Yes (implemented, needs rebuild) | ❌ Needs implementation |
| **Uses `createChat`?** | ❌ Requires direct `ChatClient` | ✅ Yes |
| **Clone overhead** | ~2-5 object spreads per tool-call message | None |
| **Depends on `part.state`?** | Yes (via clone workaround) | No: reads own `$state` Map |
| **Uses TanStack AI approval flow?** | Yes | No: bypasses it entirely |
| **`$effect.root` needed?** | No | No |
| **Server changes?** | None | Remove `needsApproval` from tool definitions |
| **Complexity** | Low (3 clone points) | Medium (new approval state management) |
| **Fragility** | Depends on TanStack AI's mutation model not changing | Depends on `execute()` being called for client tools |
| **Upstream alignment** | Works with TanStack AI's intended pattern | Works against it |
| **Future-proof** | If TanStack fixes mutations, clone becomes unnecessary (harmless) | If TanStack fixes mutations, we have a parallel system |

## Architecture

### Option A: Targeted Clone

```
┌─ ConversationHandle ──────────────────────────────────────────┐
│                                                                │
│  ChatClient (direct)                                           │
│    ├── onMessagesChange: clone tool-call parts → $state        │
│    ├── onStatusChange: re-clone + timeout logic                │
│    ├── onLoadingChange: $state                                 │
│    └── onErrorChange: $state                                   │
│                                                                │
│  let messages = $state(clonedMessages)  ← new objects          │
│  let status = $state('ready')                                  │
│  let isLoading = $state(false)                                 │
│  let error = $state(undefined)                                 │
│                                                                │
│  ToolCallPart reads part.state from cloned object ── works ✓   │
└────────────────────────────────────────────────────────────────┘
```

### Option B: Approval-in-Execute

```
┌─ ConversationHandle ──────────────────────────────────────────┐
│                                                                │
│  createChat({ tools, connection, onFinish, onError })          │
│    └── manages messages, status, isLoading, error internally   │
│                                                                │
│  let pendingApprovals = $state(new Map<string, {               │
│    toolName: string,                                           │
│    args: unknown,                                              │
│    resolve: (approved: boolean) => void                        │
│  }>())                                                         │
│                                                                │
│  Tool execute functions:                                       │
│    query tools → run immediately, return result                │
│    mutation tools → set pendingApprovals → await → run or deny │
│                                                                │
│  ToolCallPart reads pendingApprovals Map ── works ✓            │
│  (part.state is ignored for approval: always stale)           │
└────────────────────────────────────────────────────────────────┘
```

## Edge Cases

### Multiple Tool Calls in One Response

The AI might call multiple tools in a single response (e.g., "close tab A, open tab B").

- **Option A**: Both tool-call parts get cloned. Approval buttons render for each.
- **Option B**: Both `execute` functions fire. Both add to `pendingApprovals`. The user sees two approval dialogs. The ChatClient waits for both `pendingToolExecutions` to resolve before checking for continuation.

### Same Tool Called Twice with Same Args

Rare but possible. The AI calls "tabs_open" twice with the same URL.

- **Option A**: Each part has a unique `part.id`. No conflict.
- **Option B**: `execute` is called twice. Each call adds to `pendingApprovals`. Keyed by what? Not `toolCallId` (not available in execute). Must use a generated unique key or a queue per tool name.

### User Denies a Tool

- **Option A**: `addToolApprovalResponse({ id, approved: false })` → ChatClient handles denial → sends denial result to server → model acknowledges.
- **Option B**: `execute` returns `{ error: 'User denied this action' }` → `addToolResult` with error → model receives error as tool output → model acknowledges. Semantically different from a denial (it's an error, not a soft denial), but models generally handle both.

### Auto-Approve (Always Allow)

- **Option A**: `toolTrustState.shouldAutoApprove(name)` → `$effect` in ToolCallPart fires `onApproveToolCall` automatically.
- **Option B**: `execute` checks `toolTrustState.shouldAutoApprove(name)` → skips the approval dialog → runs immediately. Simpler: no `$effect` needed.

### Extension Sidepanel Destroyed During Approval

User closes the sidepanel while a tool is awaiting approval.

- **Option A**: ChatClient is destroyed. Timer cleared. No issue.
- **Option B**: ChatClient is destroyed. The `execute` Promise never resolves. `pendingToolExecutions` is abandoned. No issue: the ChatClient is gone.

## Open Questions

1. **`execute` doesn't receive `toolCallId`: how does the UI match pending approvals to ToolCallPart components?**
   - Options: (a) Match by tool name + JSON-stringified args (fragile for duplicate calls), (b) Generate a unique key per execute call and pass it via a side channel, (c) Contribute upstream to pass `toolCallId` as second arg to `execute`
   - **Recommendation**: Start with (a): duplicate tool calls with identical args are rare. File upstream issue for (c) as the proper fix.

2. **Should we completely remove `needsApproval` from tool definitions, or keep it for documentation?**
   - If removed: server sends `tool-input-available` for all tools, approval is purely client-side
   - If kept: server sends `approval-requested` for mutations: but we'd ignore it on the client. Confusing.
   - **Recommendation**: Remove from `toToolDefinitions` (wire payload). Keep the `mutation` vs `query` distinction in the Action type for our own code.

3. **What does the ToolCallPart component render while awaiting approval?**
   - Currently: spinner (isRunning) until approval, then approval buttons (isApprovalRequested)
   - With Option B: the part has no output (isRunning = true → spinner), AND there's a pending approval in our Map. We need to check both: show approval UI when pendingApprovals has an entry for this tool call, show spinner otherwise.
   - **Recommendation**: The ToolCallPart component checks `pendingApprovals` first. If a matching entry exists, show approval buttons. Otherwise, fall back to existing logic (spinner / completed / failed).

4. **Is `@tanstack/ai-event-client` viable as a production dependency for a hybrid approach?**
   - Pro: gives us typed events (`tools:approval:requested`) at exact timing
   - Con: it's a devtools package: API stability not guaranteed
   - **Recommendation**: Don't depend on it. The approval-in-execute approach doesn't need it.

## Implementation Plan

### If Option A (Targeted Clone)

Already implemented. Remaining work:

- [ ] **A.1** Rebuild the extension with current code (targeted clone is committed but not deployed)
- [ ] **A.2** Test: ask AI to open a tab → approval buttons should render
- [ ] **A.3** Test: approve → tab opens → continuation text arrives
- [ ] **A.4** Test: deny → model acknowledges denial

### If Option B (Approval-in-Execute)

- [ ] **B.1** Revert to `createChat` in `chat-state.svelte.ts` (remove direct ChatClient, remove clone)
- [ ] **B.2** Add `pendingApprovals` `$state` Map to the ConversationHandle
- [ ] **B.3** Create `requestApproval(toolName, args): Promise<boolean>` utility in handle closure
- [ ] **B.4** Modify `actionsToClientTools` in `tool-bridge.ts`: mutation tool `execute` functions call `requestApproval` before running the action handler
- [ ] **B.5** Remove `needsApproval` from `toToolDefinitions` output (server no longer sends APPROVAL_REQUESTED)
- [ ] **B.6** Update `ToolCallPart.svelte` to check `pendingApprovals` Map (passed as prop) instead of `part.state`
- [ ] **B.7** Update auto-approve logic: move from `$effect` in ToolCallPart to inside `execute` (check `toolTrustState.shouldAutoApprove` before showing dialog)
- [ ] **B.8** Thread `pendingApprovals` through AiChat → MessageList → MessageParts → ToolCallPart
- [ ] **B.9** Test all flows: approve, deny, auto-approve, multiple tools, sidepanel destruction

## Success Criteria

- [ ] Tool calls requiring approval show Allow/Always Allow/Deny buttons within 1 second of the tool-call appearing
- [ ] Approved tools execute and return results; continuation fires
- [ ] Denied tools return an error result; model acknowledges gracefully
- [ ] Auto-approve (Always Allow) works for trusted tools
- [ ] Multiple tool calls in one response each get independent approval
- [ ] No spinner stuck forever: every tool call either completes, shows approval, or shows an error
- [ ] `bun run typecheck` passes with zero new errors

## References

- `apps/tab-manager/src/lib/chat/chat-state.svelte.ts`: ConversationHandle factory (the file being changed)
- `packages/ai/src/tool-bridge.ts`: `actionsToClientTools` and `toToolDefinitions` (Option B changes this)
- `apps/tab-manager/src/lib/components/chat/ToolCallPart.svelte`: Approval UI component
- `apps/tab-manager/src/lib/state/tool-trust.svelte.ts`: Auto-approve state
- `~/Code/ai/packages/typescript/ai/src/activities/chat/stream/message-updaters.ts`: TanStack AI's mutation functions (read-only reference)
- `~/Code/ai/packages/typescript/ai/src/activities/chat/stream/processor.ts`: StreamProcessor event handling (read-only reference)
- `~/Code/ai/packages/typescript/ai-client/src/chat-client.ts`: ChatClient tool execution flow (read-only reference)
- `~/Code/ai/packages/typescript/ai-svelte/src/create-chat.svelte.ts`: createChat internals (read-only reference)
- `specs/20260313T080000-chat-architecture-redesign.md`: Parent spec (Phase 1-3 implemented)
