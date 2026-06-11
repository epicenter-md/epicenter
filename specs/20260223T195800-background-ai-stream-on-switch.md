# Background AI Stream on Conversation Switch

**Date**: 2026-02-23
**Status**: Complete
**Author**: AI-assisted

## Overview

When a user switches conversations mid-stream, the AI response finishes generating in the background. The completed response appears in Y.Doc when the user switches back. Multiple conversations can stream concurrently.

## Motivation

### Problem

Switching conversations while an AI response was streaming killed the stream. `stop()` aborted the SSE fetch, `onFinish` never fired, and the partial response was lost. This caused:

1. **Lost responses**: a 30-second generation gone if the user glances elsewhere.
2. **Wasted API spend**: tokens generated but thrown away.
3. **Friction**: users learn to avoid switching, defeating multi-conversation support.

### Solution

Replace the single shared `ChatClient` with one instance per conversation. Each instance owns its own stream, so switching conversations just changes which instance the getters read from. Background streaming requires zero additional state management.

## Architecture

### Before: Single ChatClient with Message Swapping

```
┌──────────────────────────────────────┐
│  ONE ChatClient instance             │
│  - setMessages() swaps on switch     │
│  - stop() kills stream on switch     │
│  - onFinish uses activeConversationId│
│    (wrong if user switched away)     │
└──────────────────────────────────────┘
```

Switching = `stop()` → update active ID → `setMessages()`. Stream always dies.

### After: Per-Conversation ChatClient Instances

```
┌────────────────────────────────────────────────────────┐
│  Map<conversationId, ChatClient>                       │
│                                                        │
│  conv-A: ChatClient { streaming... }  ← background     │
│  conv-B: ChatClient { idle }          ← user is here   │
│  conv-C: ChatClient { streaming... }  ← also background│
│                                                        │
│  activeConversationId = "conv-B"                       │
│  getters read from Map.get(activeConversationId)       │
└────────────────────────────────────────────────────────┘
```

Switching = `activeConversationId = newId` + refresh idle instances from Y.Doc.

### Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Instance lifecycle | Lazy creation via `ensureChat()` | Only allocate when the user interacts with a conversation |
| `onFinish` correctness | `conversationId` baked into closure at creation | Can never persist to the wrong conversation: correct by construction |
| Concurrent streams | Unlimited (bounded by instance cache) | Each ChatClient has its own AbortController and stream processor |
| Instance eviction | LRU-style, max 20 cached | Prevents unbounded memory growth; evicts idle, non-streaming instances |
| Switch behavior | Refresh idle instances from Y.Doc | Ensures view reflects latest persisted state after background completion |
| Connection callback | Reads provider/model at request time | Provider/model changes take effect on next send without recreating the instance |

## Implementation

### Files Changed

- `apps/tab-manager/src/lib/state/chat.svelte.ts`: sole state module (refactored)
- `apps/tab-manager/src/lib/components/AiChat.svelte`: streaming indicator in conversation list

### State Module (`chat.svelte.ts`)

**Added:**
- `chatInstances: Map<string, ChatClient>`: per-conversation instance cache
- `ensureChat(conversationId)`: lazy factory, creates ChatClient with baked-in `conversationId`
- `evictStaleInstances()`: removes idle instances when cache exceeds 20
- `isStreaming(conversationId)`: public method for background streaming indicators
- `chatMessages.observe()` handler: refreshes idle instances when Y.Doc messages change (background completion sync)

**Removed:**
- Single `chatInstance` created at module init
- `streamingConversationId` state variable
- `isBackgroundStreaming` derived
- `realignChatClient()` helper
- Routing logic in all 4 getters (messages, isLoading, error, status)
- If/else state machine in `switchConversation()`
- "Stop background, realign, then send" dance in `sendMessage()`

**Simplified:**
- `switchConversation()` → ID assignment + conditional Y.Doc refresh for idle instances
- All getters → `ensureChat(activeConversationId).property`
- `sendMessage()` → no background stream handling needed
- `deleteConversation()` → stop + delete instance from Map
- `reload()` / `stop()` → operate on `ensureChat(activeConversationId)`

### Switch Behavior

```typescript
function switchConversation(conversationId: string) {
    activeConversationId = conversationId;

    // Refresh idle instances from Y.Doc so the view is always current.
    // Streaming instances keep their internal state (includes the
    // in-progress assistant message that Y.Doc doesn't have yet).
    const instance = chatInstances.get(conversationId);
    if (instance && !instance.isLoading) {
        instance.setMessages(loadMessagesForConversation(conversationId));
    }
}
```

Why both paths matter:
- **Idle instance**: Refresh from Y.Doc to pick up responses that completed in the background (written by `onFinish`).
- **Streaming instance**: Keep ChatClient's internal state: it has the in-progress assistant message that Y.Doc doesn't have yet. Switching back reconnects to the live stream.

### Background Completion Sync

```typescript
popupWorkspace.tables.chatMessages.observe(() => {
    for (const [id, instance] of chatInstances) {
        if (instance.isLoading) continue;
        instance.setMessages(loadMessagesForConversation(id));
    }
});
```

When a background stream completes, `onFinish` writes the assistant message to Y.Doc. This triggers the `chatMessages` observer, which refreshes all idle ChatClient instances from Y.Doc. Streaming instances are skipped. They have the in-progress assistant message that Y.Doc doesn't have yet.

This complements `switchConversation()`'s refresh: the observer handles "message appeared while viewing another conversation," while `switchConversation()` handles "user returns to a conversation."

### Consumer (`AiChat.svelte`)

- Added `LoaderCircleIcon` import
- Spinning loader icon next to conversations generating in the background
- Zero changes to how the public API is consumed: all existing getters/methods unchanged

### Instance Eviction Strategy

```typescript
const MAX_CACHED_INSTANCES = 20;

function evictStaleInstances() {
    if (chatInstances.size <= MAX_CACHED_INSTANCES) return;

    for (const [id, instance] of chatInstances) {
        if (chatInstances.size <= MAX_CACHED_INSTANCES) break;
        if (id === activeConversationId) continue;  // keep active
        if (instance.isLoading) continue;            // keep streaming
        chatInstances.delete(id);                    // evict idle
    }
}
```

- Triggered after every new instance creation in `ensureChat()`
- Iterates in Map insertion order (oldest first)
- Preserves active and streaming instances
- Evicted conversations seamlessly recreate on next access (messages reload from Y.Doc)

## Edge Cases

### User switches rapidly between 3+ conversations

Each conversation has its own instance. Switching just reads a different instance. No state machine, no special handling.

### User sends message while another conversation streams in background

Just works. `ensureChat(activeConversationId)` returns the active conversation's ChatClient. The background conversation's ChatClient is untouched.

### User deletes a conversation that is streaming in the background

`deleteConversation()` calls `instance.stop()` and `chatInstances.delete(id)` before removing from Y.Doc.

### Stream error during background streaming

Each instance's `error` getter is scoped to that instance. The active conversation's `error` getter only shows errors for that conversation. Background errors surface when the user switches to that conversation.

### Evicted conversation accessed again

`ensureChat()` creates a fresh instance, loading messages from Y.Doc. The user sees the full conversation history (including any response that completed in the background and was persisted via `onFinish`).

## Success Criteria

- [x] User can switch conversations while streaming without losing the response
- [x] Switching back after stream completes shows the full assistant response
- [x] Switching back during streaming reconnects to the live stream view
- [x] Sending a new message while background streaming works (no interference)
- [x] Multiple conversations can stream concurrently
- [x] `isLoading` scoped to active conversation (background streams don't leak)
- [x] Streaming indicator visible in conversation list for background streams
- [x] Instance cache bounded at 20 with eviction of idle instances
- [x] No server code changes
- [x] Zero breaking changes to public API

## Review

### What Changed

The entire architecture shifted from "one ChatClient shared across conversations" to "one ChatClient per conversation." This eliminated the background streaming state machine entirely: what was 140+ lines of state tracking (`streamingConversationId`, `isBackgroundStreaming`, `realignChatClient()`, routing in 4 getters) became zero lines because background streaming is a free consequence of per-instance isolation.

### Why Per-Conversation Instances

The single-instance approach forced a fundamental coupling: "what the user sees" and "what the ChatClient streams for" were the same thing. Every feature that violated this coupling (background streaming, concurrent streams, error isolation) required additional state machinery to work around it.

Per-conversation instances remove the coupling entirely. Each instance is self-contained: its own messages, its own stream, its own lifecycle. The "active conversation" concept only controls which instance the UI reads from. It doesn't affect any instance's behavior.

### TanStack AI Internals (confirmed via DeepWiki)

- `ChatClient.stop()` prevents `onFinish` from firing (abort kills the stream)
- `ChatClient.sendMessage()` returns early if `isLoading` is true (one stream per instance)
- `setMessages()` fully replaces internal state (used for Y.Doc refresh on switch)
- `fetchServerSentEvents` options callback re-evaluates on each `connect()` call (fresh provider/model per request)
- `createChat()` from `@tanstack/ai-svelte` uses `$state` runes that work outside component context

### References

- `apps/tab-manager/src/lib/state/chat.svelte.ts`: state module
- `apps/tab-manager/src/lib/components/AiChat.svelte`: primary consumer
- `apps/tab-manager/src/lib/components/ModelCombobox.svelte`: secondary consumer (unchanged)
