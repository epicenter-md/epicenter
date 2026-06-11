# Fix Stuck Tool Approval Flow

## Problem

Asking the AI to "open a tab" sometimes shows a stuck "Open Tab…" tool call with a spinning loader and no approval buttons. The tool call hangs indefinitely instead of showing [Allow] / [Always Allow] / [Deny].

## Root Cause

TanStack AI's `updateToolCallApproval()` in `message-updaters.js` creates a **hybrid mutation**: it mutates the tool-call part object **in-place** while also returning a new message array. The `cloneMessages()` in `chat-state.svelte.ts` does `{ ...p }` to shallow-clone tool-call parts, but the `approval` nested object is shared by reference.

When Svelte 5's `$state` proxy wraps a part object from a previous render cycle, and `updateToolCallApproval` mutates the underlying object through a non-proxied reference, the proxy may not detect the change. The `{ ...p }` spread creates a "new" object whose properties are reference-equal to what the proxy already cached, so Svelte's dirty-checking can skip the re-render.

The "sometimes" nature comes from timing: the `setTimeout(0)` yield between SSE chunks in `processStream()` creates variable gaps. When the CUSTOM(approval-requested) event arrives in the same render cycle as earlier events, the mutation is captured. When it crosses a render boundary, the shared-reference issue can cause Svelte to miss the update.

### Evidence

- Static trace confirms the CUSTOM SSE event IS emitted by all 4 providers (Anthropic, OpenAI, Gemini, Grok all map tool-use finish reasons → `finishReason: "tool_calls"`)
- `completeAllToolCalls()` in `finalizeStream()` does NOT overwrite the approval-requested state (checks internal Map, not UIMessage parts)
- The only uncontrolled variable is the Svelte reactivity boundary between the in-place mutation and the shallow clone

### Secondary Issue

Line 384 of `chat-state.svelte.ts` references `streamStore` and `DEFAULT_STREAM_STATE` which are undefined. Dead code from a refactor. The `isCreditsExhausted` getter would throw `ReferenceError` if accessed. Currently nothing accesses it (grep-verified), but it should be cleaned up.

## Plan

- [ ] 1. Deep-clone tool-call parts in `cloneMessages()`: spread the `approval` nested object to break all shared references
- [ ] 2. Add diagnostic `console.log` in `onMessagesChange` for approval-requested parts (temporary, for runtime verification)
- [ ] 3. Fix the dead `isCreditsExhausted` getter: replace `streamStore` reference with the handle's own `error` state
- [ ] 4. Verify with `lsp_diagnostics`

## Changes

### 1. `apps/tab-manager/src/lib/chat/chat-state.svelte.ts`: `cloneMessages()`

Before:
```typescript
const cloneMessages = (msgs: UIMessage[]) =>
    msgs.map((m) => {
        if (m.role !== 'assistant') return m;
        const hasToolCall = m.parts.some((p) => p.type === 'tool-call');
        if (!hasToolCall) return m;
        return { ...m, parts: m.parts.map((p) => (p.type === 'tool-call' ? { ...p } : p)) };
    });
```

After:
```typescript
const cloneMessages = (msgs: UIMessage[]) =>
    msgs.map((m) => {
        if (m.role !== 'assistant') return m;
        const hasToolCall = m.parts.some((p) => p.type === 'tool-call');
        if (!hasToolCall) return m;
        return {
            ...m,
            parts: m.parts.map((p) => {
                if (p.type !== 'tool-call') return p;
                const clone = { ...p };
                // Deep-clone approval to break shared references from in-place mutations.
                // TanStack AI's updateToolCallApproval() mutates parts in-place: the shallow
                // spread above copies the reference, but Svelte 5's proxy may cache the old
                // reference identity and miss the state change.
                if ('approval' in clone && clone.approval) {
                    clone.approval = { ...clone.approval };
                }
                return clone;
            }),
        };
    });
```

### 2. Diagnostic logging (temporary)

Add a console.log in `onMessagesChange` to verify approval-requested events arrive at runtime.

### 3. Fix `isCreditsExhausted` getter

Replace the dead `streamStore` reference:
```typescript
get isCreditsExhausted() {
    if (!error) return false;
    return error.message.includes('status: 402');
}
```

## Risk

Low. Changes are:
1. A deeper clone in an existing clone function (same pattern, just one more spread)
2. A console.log (removable)
3. Fixing dead code to use an already-available local variable

No architecture changes. No new dependencies. No changes to TanStack AI internals.

## Review

All changes in `apps/tab-manager/src/lib/chat/chat-state.svelte.ts`:

1. **`cloneMessages()` (lines 80-115)**: Deep-clones the `approval` nested object on tool-call parts. Previously only did `{ ...p }` which copied the `approval` reference. Now does `{ ...clone.approval }` to break all shared references from TanStack AI's in-place mutations. This ensures Svelte 5's proxy always sees a fresh object identity when approval state changes.

2. **`onMessagesChange` callback (lines 249-268)**: Added DEV-only diagnostic logging that fires when approval-requested parts are detected. Logs part name, state, and approval data. Gated behind `import.meta.env.DEV` so it's stripped in production builds.

3. **`isCreditsExhausted` getter (lines 421-424)**: Replaced `streamStore.get(conversationId)` (undefined: dead code from refactor) with `error` (the handle's own `$state` variable). Previously would have thrown `ReferenceError: streamStore is not defined` if accessed.

Zero type errors. No architecture changes. Single file changed.
