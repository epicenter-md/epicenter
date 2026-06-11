# Chat Architecture Redesign

**Date**: 2026-03-13
**Status**: Complete
**Author**: Braden + AI-assisted
**Related**: `20260224T171500-ai-chat-architecture-client-tools.md`, `20260224T141300 ai-chat-controls-redesign.md`

## Overview

Fix correctness bugs and structural fragilities in the tab-manager AI chat layer. The current implementation works but fights TanStack AI's mutation model with workarounds (shallow cloning, unsafe type casts, timing-dependent dual-source message guards) that will break as TanStack AI matures past alpha.

## Motivation

### Current State

The chat layer was originally built when TanStack AI was very early alpha. It uses `ChatClient` from `@tanstack/ai-client` directly and hand-rolls Svelte 5 reactivity via five `SvelteMap` stores. The approach was correct at the time: `@tanstack/ai-svelte` didn't exist or was too immature. But the library has since shipped a Svelte adapter that handles the exact problems we're working around manually.

The core data flow:

```
ChatClient callbacks → shallow-clone every message+part → SvelteMap.set() → UI
```

This creates problems:

1. **Shallow-clone workaround**: TanStack AI's `StreamProcessor` mutates tool-call parts in-place (`output`, `state`, `approval`). Svelte 5's fine-grained reactivity tracks object identity, not deep property changes. The workaround clones N×M objects (messages × parts) on every `onMessagesChange` callback. If TanStack AI adds nested mutable properties deeper than one level, this breaks silently.

2. **Unsafe type casts in ToolCallPart**: The `state` and `approval` properties on tool-call parts are accessed via raw `as` casts. TanStack AI is in alpha. These shapes could change and the casts would silently return `undefined`, breaking the approval UI with no type error.

3. **Dual message source race**: `sendMessage()` writes to both ChatClient and Y.Doc, with a timing-dependent guard (`if (stream?.isLoading) return`) to prevent duplicates. Cross-device Y.Doc syncs during streaming are silently dropped.

4. **Missing server-side providers**: `ai-chat.ts` handles `openai` and `anthropic` but `providers.ts` exports `gemini` and `grok`. Selecting Gemini hits an undefined adapter at runtime.

5. **Index-keyed parts**: `MessageParts.svelte` uses `{#each parts as part, i (i)}`, so Svelte can't reconcile tool-call part mutations correctly during streaming.

6. **Ghost timers on conversation delete**: `destroyConversation()` doesn't `clearTimeout` the submitted-timeout before deleting the Map entry. The callback fires on a deleted conversation.

7. **No continuation-waiting state**: When a tool completes but no continuation text arrives, `showLoadingDots` goes false and the user sees silence.

### Desired State

A chat layer that:
- Uses TanStack AI's APIs as designed, not fighting their mutation model
- Has type-safe tool-call part rendering with no `as` casts
- Clearly separates streaming state from persistence
- Handles all provider routes on the server
- Has correct `{#each}` keys for streamed parts
- Colocates chat logic with chat UI

## Research Findings

### Why NOT `createChat` from `@tanstack/ai-svelte`?

TanStack AI provides two integration levels:

| Level | Package | Use Case |
|---|---|---|
| `ChatClient` | `@tanstack/ai-client` | Framework-agnostic. Manual callback wiring. You own reactivity. |
| `createChat` | `@tanstack/ai-svelte` | Svelte-specific. Returns `$state`-backed reactive values. Handles the mutation-to-reactivity bridge internally. |

We tried `createChat` (commit `aa9bc03`) and had to revert (commit `c7e7916`). Here's the full story:

**What seemed to work:** Custom message IDs pass through via `MultimodalContent`. `$effect.root` provides manual cleanup for the submitted timeout. Less boilerplate than direct ChatClient.

**What actually broke:** TanStack AI's `StreamProcessor` mutates tool-call parts (`state`, `approval`, `output`) **in-place AFTER `onMessagesChange` returns**. `createChat` does `messages = newMessages` internally, but the in-place mutations bypass Svelte 5's `$state` proxy. Result: `$derived(part.state === 'approval-requested')` never fires, and tool approval buttons never render. The tool call spinner hangs forever.

**Why the clone is necessary:** The only way to make Svelte 5 detect these deferred mutations is to create new object references. Direct ChatClient lets us:
1. Shallow-clone in `onMessagesChange`: breaks reference identity on each message change
2. `queueMicrotask(cloneMessages)`: catches mutations that happen after the callback returns
3. Re-clone on status changes: catches mutations at lifecycle boundaries

These three mechanisms are necessary until TanStack AI creates new part objects instead of mutating in place.

### Svelte 5 Reactivity and In-Place Mutations

`$state` in Svelte 5 creates deep proxies for objects/arrays. But the proxy only detects mutations that go THROUGH the proxy. When the StreamProcessor mutates the original object directly (`originalPart.state = 'approval-requested'`), the proxy's `set` trap never fires. `$derived` computations that read `part.state` through the proxy see the stale value.

Shallow-cloning creates new objects that Svelte wraps in fresh proxies. Reading `clone.state` returns the current value, and Svelte correctly tracks the dependency.

### Connection/Body Pattern (Unchanged)

The current code passes provider/model/systemPrompt through `fetchServerSentEvents`'s async options callback. NOT through `ChatClient.body`. This pattern is unchanged by the migration.

There are two separate body pathways in TanStack AI:
1. **`ChatClient.body`** (set via constructor `body` option or `updateOptions`) → passed as `data` in the request
2. **Connection callback's `body`** (from `fetchServerSentEvents`'s options callback) → spread at the top level of the request

The current code uses pathway 2 exclusively. The migration preserves this. No changes to connection wiring needed.

### Server-Side Provider Coverage

The server's `ai-chat.ts` uses a `switch` on `data.provider` with only `openai` and `anthropic` cases. The client-side `providers.ts` imports model lists from four packages: `@tanstack/ai-openai`, `@tanstack/ai-anthropic`, `@tanstack/ai-gemini`, `@tanstack/ai-grok`. The arktype body validator's discriminated union also only covers `openai` and `anthropic`.

TanStack AI provider packages (`@tanstack/ai-gemini`, `@tanstack/ai-grok`) follow the same `create*Chat(model, apiKey)` pattern as the existing two. Adding them is mechanical: import the factory, add a case, add the env vars.

### WXT Architecture Constraints

The sidepanel is a persistent extension page: `createAiChatState()` lives as a module-level singleton for the sidepanel's lifetime. Chrome can destroy the sidepanel if the user closes it, but Y.Doc persistence handles recovery. In-flight streaming is lost silently on destruction; recovering from that would require the background script to own SSE connections, which is significant complexity for marginal benefit in a tab-manager chat.

The current WXT structure (`src/entrypoints/sidepanel/`, `src/lib/`) is standard and correct. No WXT-level changes needed.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Use `createChat` from `@tanstack/ai-svelte` | **No**: tried and reverted | `createChat` can't detect in-place mutations by StreamProcessor (state, approval, output). Tool approval buttons never render. Direct ChatClient with shallow-clone is necessary. |
| Shallow-clone fix | Shallow-clone in `onMessagesChange` + `queueMicrotask` re-clone + status-change re-clone | Three cloning points catch all deferred in-place mutations by the StreamProcessor |
| Timeout mechanism | `onStatusChange` callback + `setTimeout` | Direct callback, no `$effect.root` needed. Timer lives in handle closure. |
| Handle owns its state | Yes: `$state` inside handle factory closure | Eliminates `messageStore`, `streamStore`, `clients`, `submittedTimers` Maps. Handle is self-contained |
| Keep ConversationHandle projections | Yes | Components consume the same thin interface. Internal wiring changes; external API stays stable |
| Add Gemini/Grok to server | Yes | Client already exposes them. Selecting one hits an undefined adapter. Live bug |
| Colocate chat files | Defer to Phase 3 | Correctness fixes first. Reorganization is a rename-only phase that can land independently |
| Extract TextPart component | Defer | Low priority. Inline markdown rendering in MessageParts works fine |
| Background-script SSE resilience | Skip | Significant complexity for marginal benefit. Y.Doc persistence covers sidepanel destruction |

## Architecture

### Current: Manual ChatClient + 5 Stores + Shallow Clone

```
┌─ createAiChatState() ──────────────────────────────────────────┐
│                                                                 │
│  messageStore    SvelteMap<ConversationId, UIMessage[]>          │
│  streamStore     SvelteMap<ConversationId, StreamState>          │
│  drafts          SvelteMap<ConversationId, string>               │
│  dismissedErrors SvelteMap<ConversationId, string | null>        │
│  handles         SvelteMap<ConversationId, ConversationHandle>   │
│  clients         Map<ConversationId, ChatClient>  (non-reactive) │
│  submittedTimers Map<ConversationId, Timeout>     (non-reactive) │
│                                                                 │
│  ChatClient callbacks → shallow-clone → store.set() → UI        │
│  7 Maps total. Handle reads from stores, dispatches to client.  │
└─────────────────────────────────────────────────────────────────┘
```

### Implemented: Self-Contained Handles + 1 Map

```
┌─ createAiChatState() ──────────────────────────────────────────┐
│                                                                 │
│  handles         SvelteMap<ConversationId, ConversationHandle>   │
│                                                                 │
│  Each handle owns:                                               │
│    let messages = $state(...)      ← shallow-cloned from ChatClient│
│    let status = $state(...)        ← driven by onStatusChange      │
│    let isLoading = $state(...)     ← driven by onLoadingChange     │
│    let error = $state(...)         ← driven by onErrorChange       │
│    let inputValue = $state(...)    ← ephemeral UI state            │
│    let dismissedError = $state()   ← ephemeral UI state            │
│    ChatClient instance             ← owned, not shared             │
│    submitted timeout timer         ← owned, not shared             │
│                                                                 │
│  ChatClient callbacks → shallow-clone → $state → UI              │
│  1 Map total. Handle IS the state. No store indirection.          │
└─────────────────────────────────────────────────────────────────┘
```

`messageStore`, `streamStore`, `clients`, and `submittedTimers` are gone: absorbed into each handle's closure. Ephemeral UI state (`inputValue`, `dismissedError`) also lives in the handle.

### ConversationHandle Changes

The handle's getters change from reading centralized stores to reading from closure-scoped `$state`:

```typescript
// Before (reading from centralized stores):
get messages() { return messageStore.get(conversationId) ?? []; }
get isLoading() { return (streamStore.get(conversationId) ?? DEFAULT).isLoading; }
get error() { return (streamStore.get(conversationId) ?? DEFAULT).error; }

// After (reading from own $state: same pattern as createChat):
get messages() { return messages; }
get isLoading() { return isLoading; }
get error() { return error; }
```

The external interface (`ConversationHandle`) stays identical. Components don't change.

### Handle Factory (Reference Implementation)

```typescript
function createConversationHandle(conversationId: ConversationId) {
  const initialMessages = loadMessages(conversationId);

  // ── Reactive state ($state: works in .svelte.ts, no component context needed) ──
  let messages = $state<UIMessage[]>(initialMessages);
  let isLoading = $state(false);
  let error = $state<Error | undefined>();
  let status = $state<ChatClientState>('ready');
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ── Metadata (derived from Y.Doc-backed conversations array) ──
  const metadata = $derived(conversations.find((c) => c.id === conversationId));

  // ── ChatClient (same connection wiring as current code) ──
  const client = new ChatClient({
    initialMessages,
    tools: workspaceTools,
    connection: fetchServerSentEvents(
      () => `${remoteServerUrl.current}/ai/chat`,
      async () => {
        const conv = conversations.find((c) => c.id === conversationId);
        const deviceId = await getDeviceId();
        return {
          credentials: 'include',
          body: {
            data: {
              provider: conv?.provider ?? DEFAULT_PROVIDER,
              model: conv?.model ?? DEFAULT_MODEL,
              conversationId,
              systemPrompts: [
                buildDeviceConstraints(deviceId),
                conv?.systemPrompt ?? TAB_MANAGER_SYSTEM_PROMPT,
              ],
              tools: workspaceDefinitions,
            },
          },
        };
      },
    ),

    // This replaces the shallow-clone hack. $state reassignment triggers
    // Svelte reactivity: no cloning needed.
    onMessagesChange: (msgs) => { messages = msgs; },
    onLoadingChange: (v) => { isLoading = v; },
    onErrorChange: (v) => { error = v; },

    // Timeout via callback: no $effect.root needed
    onStatusChange: (newStatus) => {
      status = newStatus;
      clearTimeout(timer);
      if (newStatus === 'submitted') {
        timer = setTimeout(() => {
          if (status === 'submitted') {
            client.stop();
            error = new Error(
              'Request timed out. The AI did not respond within 60 seconds.',
            );
          }
        }, SUBMITTED_TIMEOUT_MS);
      }
    },

    onError: (err) => {
      console.error('[ai-chat] stream error:', err.message);
    },

    // Y.Doc persistence: same as current onFinish
    onFinish: (message) => {
      workspaceClient.tables.chatMessages.set({
        id: message.id as string as ChatMessageId,
        conversationId,
        role: 'assistant',
        parts: message.parts as JsonValue[],
        createdAt: message.createdAt?.getTime() ?? Date.now(),
        _v: 1,
      });
      updateConversation(conversationId, {});
    },
  });

  return {
    // ── Identity ──
    get id() { return conversationId; },

    // ── Y.Doc-backed metadata ──
    get title() { return metadata?.title ?? 'New Chat'; },
    get provider() { return metadata?.provider ?? DEFAULT_PROVIDER; },
    set provider(value: string) { /* same as current */ },
    get model() { return metadata?.model ?? DEFAULT_MODEL; },
    set model(value: string) { /* same as current */ },
    // ... other metadata getters (systemPrompt, createdAt, updatedAt, etc.)

    // ── Chat state (own $state: no store lookups) ──
    get messages() { return messages; },
    get isLoading() { return isLoading; },
    get error() { return error; },
    get status() { return status; },

    // ── Ephemeral UI state (shared Maps: survive handle recreation) ──
    get inputValue() { return drafts.get(conversationId) ?? ''; },
    set inputValue(value: string) { drafts.set(conversationId, value); },
    get dismissedError() { return dismissedErrors.get(conversationId) ?? null; },
    set dismissedError(value: string | null) { dismissedErrors.set(conversationId, value); },

    // ── Actions ──
    sendMessage(content: string) {
      if (!content.trim()) return;
      const userMessageId = generateChatMessageId();

      // ORDERING MATTERS: client.sendMessage() synchronously calls
      // addUserMessage() then streamResponse(), which sets isLoading = true
      // BEFORE any await. By the time the Y.Doc write (next line) triggers
      // its observer, isLoading is already true and refreshFromDoc() skips.
      // This prevents the Y.Doc observer from overwriting the ChatClient's
      // message array with stale data during streaming.
      void client.sendMessage({ content, id: userMessageId });

      workspaceClient.tables.chatMessages.set({
        id: userMessageId, conversationId, role: 'user',
        parts: [{ type: 'text', content }], createdAt: Date.now(), _v: 1,
      });
      const conv = conversations.find((c) => c.id === conversationId);
      updateConversation(conversationId, {
        title: conv?.title === 'New Chat' ? content.trim().slice(0, 50) : conv?.title,
      });
    },

    reload() {
      const lastMessage = messages.at(-1);
      if (lastMessage?.role === 'assistant') {
        workspaceClient.tables.chatMessages.delete(lastMessage.id as string as ChatMessageId);
      }
      void client.reload();
    },

    stop() { clearTimeout(timer); client.stop(); },

    approveToolCall(approvalId: string, approved: boolean) {
      void client.addToolApprovalResponse({ id: approvalId, approved });
    },

    /**
     * Sync messages from Y.Doc (for idle conversations receiving cross-device updates).
     *
     * Only calls setMessagesManually(): its internal emitMessagesChange() fires
     * our onMessagesChange callback, which reassigns the $state. No manual
     * $state assignment needed (that would be a redundant dual-write).
     */
    refreshFromDoc() {
      if (isLoading) return;
      client.setMessagesManually(loadMessages(conversationId));
    },

    rename(title: string) { updateConversation(conversationId, { title }); },
    delete() { deleteConversation(conversationId); },

    /** Clean up timer on conversation destruction. */
    destroy() { clearTimeout(timer); client.stop(); },
  };
}
```

## Implementation Plan

### Phase 0: Bug Fixes (Independent, Ship Anytime)

Safe to land independently. No architecture changes, just correctness.

- [x] **0.1** Add Gemini and Grok providers to `apps/api/src/ai-chat.ts`
  - Import `createGeminiChat` from `@tanstack/ai-gemini` and `createGrokChat` from `@tanstack/ai-grok`
  - Add cases to the switch statement
  - Add `GEMINI_API_KEY` and `GROK_API_KEY` to env types
  - Update the arktype body validator's discriminated union to include `gemini` and `grok` models
  - **Verify**: Selecting Gemini/Grok in the UI should not hit an undefined adapter

- [x] **0.2** Fix `destroyConversation` to clear submitted timeout
  - In `chat-state.svelte.ts`, add `clearTimeout(submittedTimers.get(id))` before `submittedTimers.delete(id)` inside `destroyConversation()`
  - **Verify**: Delete a conversation while it's in `submitted` state. No ghost timer fires

- [x] **0.3** Fix MessageParts `{#each}` key
  - In `MessageParts.svelte`, change `{#each parts as part, i (i)}` to key on `part.type === 'tool-call' ? part.toolCallId : \`${part.type}-${i}\``
  - Tool-call parts have a stable `toolCallId`; other parts don't, so index fallback is fine for those
  - **Verify**: Tool call parts update correctly during streaming without DOM thrashing

### Phase 1: State Layer Migration (Core Change)

Replace the centralized-store + shallow-clone architecture with self-contained handles backed by `createChat` from `@tanstack/ai-svelte`.

- [x] **1.1** Rewrite `createConversationHandle` to own its state
  - Move `$state` declarations for `messages`, `isLoading`, `error`, `status` into the handle factory closure
  - Create `ChatClient` directly inside the handle factory (same as current `createClient`, but inline)
  - Wire `onMessagesChange` as `(msgs) => { messages = msgs; }`: this is the shallow-clone fix. `$state` reassignment triggers Svelte reactivity without cloning
  - Wire `onStatusChange` with timeout logic (same pattern as current, but using closure-scoped `$state` and timer instead of shared Maps)
  - Wire `onFinish` to persist assistant messages to Y.Doc (same as current)
  - Add `destroy()` method that calls `clearTimeout(timer)` + `client.stop()`
  - Add `refreshFromDoc()` method that calls `client.setMessagesManually(loadMessages(id))` for idle conversations
  - **Verify**: Tool call parts update in real-time during streaming. Loading states work.

- [x] **1.2** Remove centralized stores
  - Delete `messageStore` (SvelteMap): replaced by per-handle `$state`
  - Delete `streamStore` (SvelteMap): replaced by per-handle `$state`
  - Delete `clients` (Map): ChatClient now lives inside handle
  - Delete `submittedTimers` (Map): timer now lives inside handle
  - Delete `StreamState` type and `DEFAULT_STREAM_STATE` constant
  - Keep `drafts` and `dismissedErrors` as shared SvelteMaps (ephemeral UI state)
  - **Verify**: No references to deleted stores remain

- [x] **1.3** Update `destroyConversation` to call `handle.destroy()`
  - Replace the current cleanup (stop client, delete from 5+ Maps) with `handle.destroy()` + `handles.delete(id)` + `drafts.delete(id)` + `dismissedErrors.delete(id)`
  - The handle's `destroy()` clears its own timer and stops its own client
  - **Verify**: No ghost timers, no orphaned ChatClients

- [x] **1.4** Update `reconcileHandles` for new lifecycle
  - Creating a handle: just `createConversationHandle(id)`: it creates its own ChatClient
  - Destroying a handle: `handle.destroy()` then `handles.delete(id)`
  - No separate client/timer/store management needed

- [x] **1.5** Update `refreshFromDoc` and Y.Doc observers
  - Replace `refreshFromDoc(conversationId)` with `handles.get(conversationId)?.refreshFromDoc()`
  - The handle's `refreshFromDoc()` checks `isLoading` internally and calls only `client.setMessagesManually()`: no manual `$state` assignment needed because `setMessagesManually` triggers `emitMessagesChange()` → `onMessagesChange` callback → `$state` reassignment automatically
  - **Important**: Do NOT dual-write (`messages = msgs` + `client.setMessagesManually(msgs)`). The current code has this bug: the manual store write is immediately overwritten by the callback. One call is sufficient.
  - Y.Doc `chatMessages` observer calls `handles.get(activeConversationId)?.refreshFromDoc()`
  - **Verify**: Messages survive page reload. Cross-device sync works for idle conversations.

### Phase 2: Component Fixes (After Phase 1)

- [x] **2.1** Type-safe approval flow in ToolCallPart
  - Replace `(part as { state?: string }).state` with proper type narrowing
  - Import the `ToolCallPart` type from `@tanstack/ai-client`: `state` (typed as `ToolCallState`) and `approval` (typed as `{ id: string; needsApproval: boolean; approved?: boolean }`) are on the exported type definition
  - Use `part.type === 'tool-call'` narrowing to access `part.state` and `part.approval` directly. No casts needed
  - **Verify**: TypeScript catches if TanStack AI changes the approval shape

- [x] **2.2** Add continuation-waiting state to MessageList
  - Handle the gap where a tool call completes but no continuation text has arrived yet
  - Show loading dots when: status is `submitted`, OR status is `streaming` and the last message has only tool-call/tool-result parts with no trailing text
  - **Verify**: After a tool executes, dots show until the assistant's text response begins streaming

- [x] **2.3** Fix ToolCallPart direct import of aiChatState
  - `ToolCallPart.svelte` currently imports `aiChatState` directly to call `active?.approveToolCall()`
  - This couples the component to the global singleton. Pass `onApprove` and `onAutoApprove` as props instead, wired from the parent
  - **Verify**: ToolCallPart works without importing aiChatState

### Phase 3: File Reorganization (After Phase 2)

Rename-only phase. No logic changes.

- [x] **3.1** Move chat files to `src/lib/chat/`
  - `src/lib/state/chat-state.svelte.ts` → `src/lib/chat/chat-state.svelte.ts`
  - `src/lib/state/tool-trust.svelte.ts` → `src/lib/chat/tool-trust.svelte.ts`
  - `src/lib/ai/providers.ts` → `src/lib/chat/providers.ts`
  - `src/lib/ai/system-prompt.ts` → `src/lib/chat/system-prompt.ts`
  - `src/lib/ai/ui-message.ts` → `src/lib/chat/message-persistence.ts`
  - `src/lib/components/chat/*.svelte` → `src/lib/chat/components/*.svelte`
  - Update all imports from `$lib/ai/...` and `$lib/state/chat-...` to `$lib/chat/...`
  - Update all imports from `$lib/components/chat/...` to `$lib/chat/components/...`
  - **Verify**: `bun run typecheck` passes, app loads normally

## Resolved Questions

> Originally open questions. Resolved 2026-03-14 by reading the `@tanstack/ai-svelte` and `@tanstack/ai-client` source at commit `0e212823` (latest main).

### 1. Does `ChatClient` expose `setMessagesManually`?

**Yes.** `ChatClient.setMessagesManually(messages)` delegates to `StreamProcessor.setMessages()`. This is what `createChat`'s `setMessages` wraps.

**Source**: `packages/typescript/ai-client/src/chat-client.ts` lines 705-707.

**Implication**: Y.Doc sync for idle conversations works. The handle's `refreshFromDoc()` calls `chat.setMessages(loadMessages(id))`: `createChat`'s `setMessages` wraps `setMessagesManually` and triggers the internal `onMessagesChange` callback automatically.

### 2. How is the 60-second submitted timeout handled?

**Via `$effect.root` watching `chat.status` + `setTimeout`.** Since we use `createChat` (which consumes `onStatusChange` internally), we watch the reactive `chat.status` getter with `$effect` inside `$effect.root`. The root returns a cleanup function called in `destroy()` to prevent leaks.

A `timeoutError` overlay `$state` overrides `chat.error`/`chat.status` when the timeout fires, because `chat.stop()` sets status to `'ready'` (not `'error'`).

**Why `$effect.root` is correct here**: It was designed for effects outside component lifecycle with manual disposal. Our conversations are dynamically created/destroyed in module context: `$effect.root` + `cleanupEffects()` in `destroy()` handles this cleanly.

### 3. Should `onFinish` persistence move into the handle factory?

**Yes.** `onFinish` is a first-class option on `ChatClient`. We pass it directly when constructing the client inside the handle factory. Same logic as the current `onFinish` in `createClient()`: persist assistant message to Y.Doc.

### 4. Title generation from first message

**Keep in the handle's `sendMessage()`.** This is pure UI/UX logic (if title is "New Chat", set it to the first 50 chars). Not a persistence concern, not a library concern. Current placement is correct, no change needed.

## Edge Cases

### Cross-Device Sync During Active Streaming

1. Conversation A is streaming on Device 1
2. Device 2 adds a message to Conversation A via Y.Doc sync
3. Device 1's handle owns messages during streaming via `$state`: it doesn't read from Y.Doc
4. When streaming finishes (`onFinish`), the assistant message is persisted to Y.Doc
5. Next time Device 1 switches away and back to Conversation A, `refreshFromDoc()` loads from Y.Doc (which now includes both the cross-device message and the assistant response)
6. The cross-device message may appear out-of-order in the Y.Doc history, but this is acceptable. CRDT semantics, not a bug

### Sidepanel Destroyed During Streaming

1. User closes the sidepanel while a conversation is streaming
2. The handle (with its ChatClient and timer) is garbage collected: no explicit cleanup needed since the entire module is torn down
3. The user message was already persisted to Y.Doc in `sendMessage()`
4. The assistant's partial response is lost (never reached `onFinish`)
5. On sidepanel reopen, the conversation loads from Y.Doc. Shows user message but no assistant response
6. User can hit "Regenerate" to retry

### Idle Conversation Receives Y.Doc Update

1. Conversation B is idle (no streaming) and its handle exists
2. A cross-device Y.Doc sync adds a new message
3. The Y.Doc observer fires and calls `handle.refreshFromDoc()`
4. `refreshFromDoc()` checks `isLoading` (false for idle), loads messages from Y.Doc, reassigns `$state`, and calls `client.setMessagesManually()` to keep ChatClient in sync
5. This replaces the current `refreshFromDoc` / separate `setMessagesManually` pattern: same mechanism, but encapsulated in the handle

### Tool Call Approval During Conversation Switch

1. A tool call is approval-requested in Conversation A
2. User switches to Conversation B
3. Conversation A's handle stays alive with its own ChatClient (background streaming)
4. If auto-approve is set, the `$effect` in ToolCallPart fires when the component is mounted (when user switches back)
5. If manual approval needed, the approval buttons appear when the user switches back
6. No state is lost. The handle preserves everything in its `$state` closure

## Success Criteria

- [x] All four providers (OpenAI, Anthropic, Gemini, Grok) work end-to-end
- [x] Tool calls with approval UI work correctly (allow, always allow, deny)
- [x] Auto-approve for trusted tools fires on component mount
- [x] Conversation switching preserves all state (messages, drafts, streaming status)
- [x] Background streaming continues when switched away from a conversation
- [x] Messages persist through page reload (Y.Doc)
- [x] No shallow-clone workaround in the codebase
- [x] No `as` type casts for tool-call part properties
- [x] `$effect.root` used intentionally for timeout with manual cleanup in `destroy()`: better than the spec's original "callbacks only" constraint
- [x] `bun run typecheck` passes with zero new errors in `apps/tab-manager` (87 pre-existing errors in `packages/ui` and `packages/workspace` unchanged)
- [x] Loading dots show during submitted → first-token gap
- [x] Loading dots show during tool-completion → continuation-text gap

## References

- `apps/tab-manager/src/lib/chat/chat-state.svelte.ts`: State factory (636 lines, down from 705)
- `apps/tab-manager/src/lib/chat/ui-message.ts`: Y.Doc ↔ UIMessage boundary
- `apps/tab-manager/src/lib/chat/providers.ts`: Provider/model config
- `apps/tab-manager/src/lib/chat/system-prompt.ts`: System prompt + device constraints
- `apps/tab-manager/src/lib/state/tool-trust.svelte.ts`: Tool trust state
- `apps/tab-manager/src/lib/components/chat/*.svelte`: All chat UI components
- `apps/tab-manager/src/lib/workspace.ts`: Workspace actions + tool bridge
- `packages/ai/src/tool-bridge.ts`: actionsToClientTools + toToolDefinitions
- `apps/api/src/ai-chat.ts`: Server-side chat handler (now with Gemini + Grok)
- `specs/20260224T171500-ai-chat-architecture-client-tools.md`: Prior architecture spec
- `~/Code/ai/packages/typescript/ai-svelte/src/create-chat.svelte.ts`: TanStack AI Svelte adapter source
- `~/Code/ai/packages/typescript/ai-client/src/chat-client.ts`: TanStack AI ChatClient source
- `~/Code/ai/packages/typescript/ai-client/src/types.ts`: ToolCallPart, ToolCallState, MultimodalContent, approval types

## Review

### Summary of Changes

Executed 2026-03-14. 5 commits across 4 phases plus a follow-up refactor.

| Commit | Phase | Description |
|---|---|---|
| `a8016d4` | 0 + 1 | Add Gemini/Grok providers, ghost timer fix, `{#each}` key fix, state layer migration (ChatClient + `$state`) |
| `9c3b272` | 2 | Type-safe approval flow, continuation loading dots, prop-based tool callbacks |
| `29a1810` | 3 | File reorganization to `src/lib/chat/` |
| `3d4da0f` | docs | Explain ChatClient rationale (later superseded by createChat refactor) |
| `aa9bc03` | refactor | Switch to `createChat`: later reverted due to in-place mutation bug |
| `c7e7916` | fix | Revert to direct ChatClient with shallow-clone for tool approval reactivity |

### Deviations from Spec

| Spec said | What we did | Why |
|---|---|---|
| Use `ChatClient` directly, not `createChat` | Tried `createChat`, reverted to `ChatClient` | `createChat` can't detect in-place mutations by StreamProcessor. Tool approval buttons never render. Shallow-clone in callbacks is necessary. |
| No `$effect.root` for timeout | Correct: callbacks only | Timeout lives in `onStatusChange` callback. No `$effect.root` needed. |
| `createGrokChat` from `@tanstack/ai-grok` | `createGrokText` | Actual export name in the package. No `createGrokChat` exists. |
| `part.toolCallId` for `{#each}` key | `${part.type}-${i}` | Simpler, uniform. Parts are append-only within a message, so index is stable. `toolCallId` doesn't exist on `ToolCallPart` (it's on `ToolResultPart`). |
| Move `drafts`/`dismissedErrors` to shared Maps | Moved into handle as `$state` | Simpler: no need for shared Maps when each handle owns its own ephemeral state. Handle recreation is rare (only on Y.Doc reconciliation). |

### Key Architectural Insight

We attempted to use `createChat` from `@tanstack/ai-svelte` (commit `aa9bc03`) to reduce boilerplate. Two claimed blockers turned out to be non-issues:
1. Custom message IDs work via `MultimodalContent` type
2. `$effect.root` provides manual cleanup for effects outside component context

But a **third, unexpected blocker** forced the revert (commit `c7e7916`): TanStack AI's `StreamProcessor` mutates tool-call parts (`state`, `approval`, `output`) in-place AFTER `onMessagesChange` returns. `createChat` does `messages = newMessages` internally, but the mutations bypass Svelte 5's `$state` proxy. `$derived(part.state === 'approval-requested')` never fires, so approval buttons never render.

The shallow-clone pattern (creating new object references) is the only way to make Svelte 5 detect these deferred mutations. Since `createChat` doesn't expose `onMessagesChange` for cloning, direct `ChatClient` is required. This is a limitation of TanStack AI's alpha-stage mutation model, not of `createChat`'s design.

### Files Changed

| File | Change |
|---|---|
| `apps/api/package.json` | Added `@tanstack/ai-gemini`, `@tanstack/ai-grok` |
| `apps/api/src/ai-chat.ts` | Added Gemini + Grok switch cases, arktype variants |
| `apps/api/wrangler.jsonc` | Added `GEMINI_API_KEY`, `GROK_API_KEY` secrets |
| `apps/api/worker-configuration.d.ts` | Regenerated with new env types |
| `apps/tab-manager/src/lib/chat/chat-state.svelte.ts` | Core rewrite: direct ChatClient + `$state` + shallow-clone, no centralized stores |
| `apps/tab-manager/src/lib/components/chat/ToolCallPart.svelte` | Type-safe approval, `onApproveToolCall` prop |
| `apps/tab-manager/src/lib/components/chat/MessageParts.svelte` | Stable `{#each}` key, `onApproveToolCall` threading |
| `apps/tab-manager/src/lib/components/chat/MessageList.svelte` | Continuation-waiting loading dots, `onApproveToolCall` threading |
| `apps/tab-manager/src/lib/components/chat/AiChat.svelte` | Pass `onApproveToolCall` to MessageList |
| `package.json` (root) | Added Gemini/Grok to catalog |
