# AI Chat Architecture: Sidebar createChat() with Generic Hub

**Date**: 2026-02-24
**Status**: Implemented
**Author**: Braden + AI-assisted
**Related**: `20260223T230000-bgsw-ai-runtime.md`, `20260222T195645-network-topology-multi-server-architecture.md`, `20260223T200500-ai-tools-command-queue.md`

## Overview

The sidebar runs `createChat()` from `@tanstack/ai-svelte` directly, streaming SSE from the hub server's generic `/ai/chat` endpoint. The BGSW has zero AI responsibilities. It handles only Yjs sync and browser event syncing. The hub server remains maximally generic with no app-specific tools or system prompts.

## Motivation

### Architecture Evolution

1. **Pre-branch (main)**: Hub server ran `chat()` with 13 tab-manager-specific tools + hardcoded system prompt. Sidebar used `createChat()` with `fetchServerSentEvents` for SSE streaming.
2. **BGSW branch (reverted)**: Moved `chat()` to BGSW. Sidebar sent messages via `chrome.runtime.sendMessage`, BGSW ran tools and wrote to Y.Doc progressively. Added unnecessary complexity (message passing, lifecycle management, keepalive concerns).
3. **Current (chosen)**: Revert to sidebar `createChat()` pattern from main, but keep the hub server generic (no tools, no system prompt). Simplest possible architecture.

### Why Revert

- `createChat()` in the sidebar gives us the full TanStack AI Svelte adapter DX (reactive state, automatic stream lifecycle, background streaming across conversations)
- No message passing between sidebar and BGSW for AI: eliminates a whole class of complexity
- The hub server stays generic: it just relays messages to LLM providers and streams responses back
- Side panels have full Chrome API access, so client-side tools can execute locally if needed later

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Side Panel (Svelte)                                     │
│                                                         │
│  createChat({                                           │
│    connection: fetchServerSentEvents('/ai/chat'),       │
│    // tools: clientTools(...): future                  │
│  })                                                     │
│       │                                                 │
│       │ POST /ai/chat (provider, model, messages)       │
│       ▼                                                 │
│ ┌───────────────────────────────────────────┐           │
│ │ Hub Server (Generic Relay)                │           │
│ │                                           │           │
│ │  chat({ adapter, messages })              │           │
│ │    ↓                                      │           │
│ │  SSE stream ← LLM Provider               │           │
│ └───────────────────────────────────────────┘           │
│       │                                                 │
│       │ SSE chunks                                      │
│       ▼                                                 │
│  ChatClient renders messages reactively                 │
│  onFinish → persist to Y.Doc                            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ BGSW (Background Service Worker)                        │
│                                                         │
│  - Yjs sync (WebSocket ↔ Y.Doc)                        │
│  - Browser event sync (tabs, windows, groups ↔ Y.Doc)  │
│  - Command consumer (future cross-device)               │
│  - Keepalive (Chrome MV3)                               │
│  - NO AI responsibilities                               │
└─────────────────────────────────────────────────────────┘
```

## Changes Made

### Deleted

- `apps/tab-manager/src/lib/ai/engine.ts`: BGSW chat engine
- `apps/tab-manager/src/lib/ai/adapters.ts`: BGSW adapter factory
- `apps/tab-manager/src/lib/ai/tools/definitions.ts`: Tool definition contracts
- `apps/tab-manager/src/lib/ai/tools/mutation-tools.ts`: Chrome API mutation tools
- `apps/tab-manager/src/lib/ai/tools/read-tools.ts`: Y.Doc read tools

### Modified

- `apps/tab-manager/src/entrypoints/background.ts`: Removed AI import, chat engine creation, and `onMessage` handler
- `apps/tab-manager/src/lib/state/chat.svelte.ts`: Reverted from BGSW message passing to `createChat()` + `fetchServerSentEvents` pattern

### Kept As-Is

- `packages/server/src/ai/plugin.ts`: Generic relay (already simplified on this branch)
- `apps/tab-manager/src/lib/commands/`: Command consumer for future cross-device use

## Future Directions

### Client-Side Tools (Next Step)

The sidebar has full Chrome API access. Tools can be registered as TanStack AI client tools:

```typescript
const chat = createChat({
  connection: fetchServerSentEvents('/ai/chat'),
  tools: clientTools(searchTabsTool, closeTabsTool, ...),
});
```

**Challenge**: TanStack AI's client tool pattern requires the server to know tool schemas (to include them in the LLM prompt). Options:

1. Pass tool schemas in the request body → server forwards to `chat()`
2. Run `chat()` locally in the sidebar (bypass hub for tool-using conversations)
3. Import shared tool definitions on both sides

### Cross-Device Commands

> **Update (2026-03-11):** The command queue infrastructure was removed in `specs/20260311T230000-remove-commands-table-and-awareness.md`. If cross-device AI mutations become needed, a lighter signaling mechanism (e.g., server-to-device WebSocket RPC) would likely replace it.

## Todo

- [x] Delete BGSW AI directory
- [x] Remove AI code from background.ts
- [x] Revert chat.svelte.ts to createChat() pattern
- [x] Verify typecheck passes (0 new errors)
- [x] Implement client-side tools in sidebar (follow-up): see `20260224T190000-client-side-ai-tools.md`
- [x] Add system prompt back (client-side, in createChat body): default `TAB_MANAGER_SYSTEM_PROMPT` in `$lib/ai/system-prompt.ts`
