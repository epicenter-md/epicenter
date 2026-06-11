# Client-Side AI Tools

**Date**: 2026-02-24
**Status**: Complete
**Related**: `20260224T171500-ai-chat-architecture-client-tools.md`

## Overview

Wire TanStack AI client tools into the sidebar's `createChat()`. The server stays generic. It just forwards tool schemas to the LLM. Tool execution happens client-side in the sidebar, which has full Chrome API access and Y.Doc state.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Shared: toolDefinition({ name, description, inputSchema })     │
│                                                                 │
│  .client(execute)    →  createChat({ tools })                   │
│  raw definitions     →  request body → server chat({ tools })   │
│                                                                 │
│  LLM calls tool  →  SSE tool-call event  →  ChatClient          │
│  ChatClient auto-executes  →  addToolResult  →  continues       │
└─────────────────────────────────────────────────────────────────┘
```

## Changes

### 1. Delete dead `broadcast-channel.ts`
Orphan file with zero imports.

### 2. Create `tools/definitions.ts`
Restore the 13 `toolDefinition()` contracts from git history (5 read + 8 mutation). Pure schemas, no runtime deps.

### 3. Create `tools/client.ts`
Client-side `.client(execute)` implementations:
- Read tools query `popupWorkspace.tables.*` directly (Y.Doc)
- Mutation tools call Chrome `browser.*` APIs directly (sidebar has full access)

### 4. Update server plugin
Accept `tools` from request body, forward to `chat({ tools })`. One-line change.

### 5. Wire into `chat.svelte.ts`
Pass client tools to `createChat({ tools })` and raw definitions in the request body.

## Todo

- [x] Delete broadcast-channel.ts
- [x] Create tools/definitions.ts (tool schemas)
- [x] Create tools/client.ts (client implementations)
- [x] Update server plugin to forward tools
- [x] Wire tools into chat.svelte.ts
- [x] Typecheck passes


## Review

### Summary

Implemented 13 client-side AI tools (5 read + 8 mutation) for the tab-manager sidebar chat. The server stays generic. It just forwards tool schemas from the request body to the LLM. Tool execution happens entirely client-side.

### Files Changed

| File | Change |
|------|--------|
| `apps/tab-manager/src/lib/ai/tools/definitions.ts` | Created: 13 `toolDefinition()` contracts with arktype schemas |
| `apps/tab-manager/src/lib/ai/tools/client.ts` | Created: Client `.client(execute)` implementations using Y.Doc reads + Chrome APIs |
| `packages/server/src/ai/plugin.ts` | Modified: Accept `tools` in request body, forward to `chat()` |
| `apps/tab-manager/src/lib/state/chat.svelte.ts` | Modified: Wire `tabManagerClientTools` into `createChat()` and `allToolDefinitions` into request body |
| `apps/tab-manager/src/lib/sync/broadcast-channel.ts` | Deleted: Dead code with zero imports |

### Design Decisions

1. **arktype for input schemas**: Used arktype (Standard Schema compatible) so `toolDefinition()` gets proper runtime validation. Optional fields use `'key?': 'string'` syntax per project conventions.
2. **Reused existing action functions**: Mutation tools delegate to `$lib/commands/actions.ts` which already wraps all Chrome API calls. No duplication.
3. **Device ID lazy caching**: Mutation tools need to convert composite tab IDs (`deviceId_tabId`) to native Chrome tab IDs. Used `getDeviceId()` with a module-level cache.
4. **Server forwards raw definitions**: `allToolDefinitions` (without `.client()`) are sent in the request body. The server passes them to `chat({ tools })` so the LLM sees the schemas. Client tools auto-execute when the LLM calls them.
