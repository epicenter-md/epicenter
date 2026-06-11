# Conversation Handle Refactor

**Date**: 2026-02-24
**Status**: Draft
**Author**: AI-assisted

## Overview

Replace the parallel data structures in `chat.svelte.ts` (a `chatInstances` Map + a `conversations` array + scattered active-routing boilerplate) with a single `Map<ConversationId, ConversationHandle>` where each handle is a self-contained, reactive object that owns all per-conversation state: chat instance, metadata, ephemeral UI state, and actions.

## Motivation

### Current State

`chat.svelte.ts` (712 lines) uses two parallel per-conversation structures that must stay in sync:

```typescript
// Structure 1: TanStack AI chat instances (lazy, in-memory)
const chatInstances = new Map<ConversationId, CreateChatReturn>();

// Structure 2: Y.Doc-backed metadata (reactive array)
let conversations = $state<Conversation[]>(readAllConversations());
```

Every public API method repeats the same routing dance: read `activeConversationId`, look up in one or both structures, delegate:

```typescript
get messages() {
  return ensureChat(activeConversationId).messages;    // Structure 1
},
get provider() {
  return activeConversation?.provider ?? DEFAULT_PROVIDER; // Structure 2
},
sendMessage(content: string) {
  // Reads from Structure 2 (conversation metadata)
  // Delegates to Structure 1 (chat instance)
  // Writes to Y.Doc (chat messages table)
},
```

Meanwhile, component-local state lives outside both structures entirely:

```svelte
<!-- AiChat.svelte -->
let inputValue = $state('');   // Not per-conversation: lost on switch
let dismissedError = $state<string | null>(null); // Also not per-conversation
```

This creates problems:

1. **Parallel structures drift risk**: `chatInstances` and `conversations` are independently managed. Every CRUD operation must update both. The Y.Doc observer syncs one; `ensureChat()` lazily creates the other. They use different lifecycles.
2. **Active-routing boilerplate**: ~15 public getters/methods all perform the same `activeConversationId → lookup → delegate` pattern. Each is a place for bugs.
3. **Ephemeral UI state is global**: Input drafts, dismissed errors, and scroll position are per-component, not per-conversation. Switching conversations loses drafts.
4. **Parallel access is awkward**: Checking if a non-active conversation is streaming requires a special method (`isStreaming(id)`) instead of just accessing the conversation's state directly.

### Desired State

A single Map where each entry is a self-contained `ConversationHandle`:

```typescript
// One structure to rule them all
const conv = aiChatState.get(conversationId);

conv.messages        // TanStack AI messages (reactive)
conv.isLoading       // streaming state
conv.inputValue      // per-conversation draft (preserved across switches)
conv.provider        // Y.Doc-backed, get/set
conv.sendMessage()   // action, scoped to this conversation
```

The singleton becomes a thin orchestrator. A Map + an active pointer + conversation CRUD. Each handle owns its own state and actions.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Single Map vs parallel structures | Single `Map<ConversationId, ConversationHandle>` | Eliminates sync between chatInstances and conversations array. One lookup gives you everything. |
| Handle creation | Factory function `createConversationHandle(id)` | Follows existing codebase factory pattern. Each handle gets baked-in `conversationId`: same closure pattern as current `ensureChat()`. |
| ChatClient lifecycle | Lazy inside handle (created on first `messages`/`sendMessage` access) | Matches current `ensureChat()` behavior. Conversations loaded from Y.Doc don't need a ChatClient until the user interacts. |
| Input draft storage | `$state` inside handle, in-memory only | Ephemeral UI state doesn't belong in Y.Doc. Losing drafts on extension reload is acceptable. |
| Y.Doc as source of truth for metadata | Handle reads metadata from Y.Doc via conversations array | Y.Doc observer updates the reactive `conversations` array. Handles derive metadata from this array (same as today). Handles don't duplicate Y.Doc data. |
| `active` convenience getter | `$derived` that returns `get(activeConversationId)` | Preserves the common case (component binds to active conversation) while enabling direct access by ID. |
| Conversation list type | `ConversationHandle[]` (not `Conversation[]`) | Components iterate handles directly. Each item in the list IS the conversation: no secondary lookup needed for streaming state, preview, etc. |
| Provider/model globals | Keep `availableProviders` and `modelsForProvider()` on singleton | These are global configuration, not per-conversation state. They stay on the orchestrator. |
| Error dismissal | Move `dismissedError` into handle | Currently component-local. Per-conversation dismissal means switching back to a conversation doesn't re-show an error you already dismissed. |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ aiChatState (singleton orchestrator)                        │
│                                                             │
│  handles: Map<ConversationId, ConversationHandle>           │
│  activeConversationId: $state<ConversationId>               │
│                                                             │
│  get active()  → handles.get(activeConversationId)          │
│  get conversations() → sorted ConversationHandle[]          │
│  get(id)       → handles.get(id)                            │
│                                                             │
│  create()      → Y.Doc write + new handle + switch          │
│  switchTo(id)  → update activeConversationId                │
│                                                             │
│  availableProviders, modelsForProvider() (global config)    │
└────────────────────────────┬────────────────────────────────┘
                             │ contains N handles
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ ConversationHandle (per-conversation, factory-created)      │
│                                                             │
│  ── Identity ──                                             │
│  id: ConversationId (baked in via closure)                  │
│                                                             │
│  ── Y.Doc-backed metadata (derived from conversations) ──  │
│  title, provider, model, systemPrompt,                     │
│  createdAt, updatedAt, parentId, sourceMessageId            │
│                                                             │
│  ── TanStack AI chat (lazy) ──                              │
│  messages, isLoading, error, status                         │
│                                                             │
│  ── Ephemeral UI state ($state, in-memory) ──               │
│  inputValue, dismissedError                                 │
│                                                             │
│  ── Derived convenience ──                                  │
│  lastMessagePreview                                         │
│                                                             │
│  ── Actions ──                                              │
│  sendMessage(content), reload(), stop()                     │
│  setProvider(name), setModel(name), rename(title)           │
│  delete(), refreshFromDoc()                                 │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Y.Doc conversations table
    │
    │ observe() fires on persistence load / remote sync / local write
    ▼
conversations = readAllConversations()   ← reactive $state array
    │
    │ reconcile: create handles for new IDs, remove handles for deleted IDs
    ▼
handles Map<ConversationId, ConversationHandle>
    │
    │ each handle derives metadata from conversations array
    │ each handle lazily creates its own ChatClient
    │ each handle owns its own $state for inputValue, dismissedError
    ▼
Component binds to aiChatState.active (or aiChatState.get(id))
```

### Handle ↔ Y.Doc Metadata Flow

Handles do NOT store copies of Y.Doc metadata. They derive it:

```typescript
function createConversationHandle(id: ConversationId) {
  // This re-derives whenever conversations array updates (via Y.Doc observer)
  const metadata = $derived(conversations.find(c => c.id === id));

  return {
    get title() { return metadata?.title ?? 'New Chat' },
    get provider() { return metadata?.provider ?? DEFAULT_PROVIDER },
    set provider(v) { updateConversation(id, { provider: v, model: ... }) },
    // Y.Doc observer fires → conversations updates → metadata re-derives → getter returns new value
  };
}
```

This means handles are always in sync with Y.Doc without any manual sync logic.

## Implementation Plan

### Phase 1: Create `createConversationHandle` factory

- [ ] **1.1** Define the `ConversationHandle` return type (what the factory returns)
- [ ] **1.2** Implement `createConversationHandle(id, { conversations, updateConversation, loadMessages, ... })` factory function inside `chat.svelte.ts`. Dependencies passed in to avoid circular references.
- [ ] **1.3** Move chat instance creation (current `ensureChat` body) into the handle as a lazy `chat()` accessor
- [ ] **1.4** Add `inputValue` as `$state('')` inside handle
- [ ] **1.5** Add `dismissedError` as `$state<string | null>(null)` inside handle
- [ ] **1.6** Wire up metadata getters/setters (`title`, `provider`, `model`, etc.) that derive from the `conversations` array
- [ ] **1.7** Move `sendMessage`, `reload`, `stop` logic into handle methods (baked-in `conversationId`)
- [ ] **1.8** Add `lastMessagePreview` as a getter (move from current `getLastMessagePreview` method)
- [ ] **1.9** Add `delete()` method on handle that delegates to singleton's delete logic
- [ ] **1.10** Add `refreshFromDoc()` method that calls `setMessages(loadMessagesForConversation(id))` on idle instances

### Phase 2: Refactor singleton to use handles Map

- [ ] **2.1** Replace `chatInstances` Map with `handles: Map<ConversationId, ConversationHandle>`
- [ ] **2.2** Add reconciliation logic in Y.Doc observer: create handles for new conversation IDs, clean up handles for deleted ones
- [ ] **2.3** Replace all `ensureChat(activeConversationId).X` getters with `active.X` delegation
- [ ] **2.4** Simplify `switchConversation`: just update pointer, handle's `refreshFromDoc()` called internally
- [ ] **2.5** Simplify `deleteConversation`: call `handle.delete()` which stops stream + removes from Map + Y.Doc batch
- [ ] **2.6** Add `get(id)` method that returns handle or undefined
- [ ] **2.7** Change `conversations` getter to return `ConversationHandle[]` (sorted) instead of `Conversation[]`
- [ ] **2.8** Add `get active()` convenience getter
- [ ] **2.9** Remove now-dead code: `ensureChat`, `findConversation`, `getActiveConversation`, `getLastMessagePreview`, per-property routing getters

### Phase 3: Update components

- [ ] **3.1** Update `AiChat.svelte`: remove local `inputValue` and `dismissedError` state, bind to `aiChatState.active.inputValue`, use `aiChatState.active.sendMessage()` directly, remove local `send()` function
- [ ] **3.2** Update `AiChat.svelte` conversation list: iterate `aiChatState.conversations` (now handles), access `conv.isLoading` directly instead of `aiChatState.isStreaming(conv.id)`, access `conv.lastMessagePreview` instead of `aiChatState.getLastMessagePreview(conv.id)`
- [ ] **3.3** Update `ModelCombobox.svelte`: bind to `aiChatState.active.model` and `aiChatState.active.provider` instead of `aiChatState.model` and `aiChatState.provider`
- [ ] **3.4** Verify all `aiChatState.*` usages are updated (grep for old API surface)

### Phase 4: Cleanup and verify

- [ ] **4.1** Run type check (`bun typecheck` or equivalent)
- [ ] **4.2** Run `lsp_diagnostics` on all changed files
- [ ] **4.3** Manual smoke test: send message, switch conversations, verify draft preserved, verify background streaming indicators, verify provider/model changes
- [ ] **4.4** Verify the singleton JSDoc/module doc is updated to reflect new architecture

## Edge Cases

### Handle for conversation that doesn't exist in Y.Doc yet

1. `popupWorkspace.whenReady` hasn't resolved: conversations array is empty
2. `get(id)` returns undefined, `active` returns undefined
3. UI handles this with optional chaining (same as today's `activeConversation?.title`)

### Y.Doc observer fires while a handle is streaming

1. Conversation metadata changes (e.g., remote device renames it)
2. Handle's metadata getters re-derive from updated conversations array: title updates reactively
3. Streaming is unaffected: ChatClient is independent of metadata

### Conversation deleted while its handle is streaming

1. `handle.delete()` calls `handle.stop()` first
2. Removes from handles Map and Y.Doc
3. If active, switches to next conversation (same as today)

### Y.Doc persistence loads conversations that already have handles

1. Observer fires, reconciliation runs
2. Existing handles are kept (not recreated): their ChatClient and ephemeral state survive
3. Only new IDs get handles; only removed IDs get cleaned up

### Two conversations streaming concurrently

1. Each handle owns its own ChatClient: completely independent streams
2. `handle.isLoading` is per-handle, no shared state
3. Both `onFinish` callbacks persist to correct conversation via baked-in ID (unchanged from today)

## Open Questions

1. **Should `conversations` getter return `ConversationHandle[]` or keep returning `Conversation[]`?**
   - Options: (a) Return `ConversationHandle[]`: components get rich objects, (b) Keep `Conversation[]` for the list, use `get(id)` for handles
   - **Recommendation**: (a): the whole point is collocation. The conversation list items should be able to access `.isLoading`, `.lastMessagePreview`, `.inputValue` without a secondary lookup. This is the power of the pattern.

2. **Should `active` ever be undefined?**
   - Currently `activeConversation` can be undefined before persistence loads
   - Options: (a) `active` returns `ConversationHandle | undefined` (caller must null-check), (b) Create a "placeholder" handle that returns empty/default values
   - **Recommendation**: (a): keep it honest. The UI already handles the undefined case. A placeholder handle would hide a real state (persistence not loaded) behind fake data.

3. **Should handle methods like `setProvider` auto-select the first model for the new provider?**
   - This logic currently lives in `setProvider()` on the singleton
   - **Recommendation**: Yes, move it into the handle's `provider` setter. The handle knows its own conversation and can read `PROVIDER_MODELS` to auto-select. Keeps the setter smart and the component dumb.

4. **Should `rename()` live on the handle or stay on the singleton?**
   - **Recommendation**: Handle. `conv.rename('New Title')` reads better than `aiChatState.renameConversation(conv.id, 'New Title')`. The handle has the baked-in ID.

## Success Criteria

- [ ] `chat.svelte.ts` uses a single `Map<ConversationId, ConversationHandle>` instead of parallel `chatInstances` + `conversations` structures
- [ ] `AiChat.svelte` has zero local `$state` for `inputValue`: binds to `active.inputValue`
- [ ] Switching conversations preserves input drafts
- [ ] Background streaming indicators work via `conv.isLoading` (no special `isStreaming` method)
- [ ] `ModelCombobox.svelte` binds to active handle's provider/model
- [ ] Type check passes with no errors
- [ ] No regressions: send, receive, switch, delete, create, rename, reload, stop all work

## References

- `apps/tab-manager/src/lib/state/chat.svelte.ts`: Primary refactor target (712 lines → ~400-450 estimated)
- `apps/tab-manager/src/lib/components/AiChat.svelte`: Main consumer, loses local state
- `apps/tab-manager/src/lib/components/ModelCombobox.svelte`: Secondary consumer, rebind to active handle
- `apps/tab-manager/src/lib/workspace.ts`: Conversation/ChatMessage schema (unchanged)
- `apps/tab-manager/src/lib/workspace-popup.ts`: Y.Doc client (unchanged)
