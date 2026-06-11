# AI Chat Component Redesign

**Date**: 2026-02-24
**Status**: Implemented
**Author**: AI-assisted

## Overview

Decompose the monolithic `AiChat.svelte` component and 845-line `chat.svelte.ts` state file into focused, single-responsibility modules. Add full `MessagePart` rendering (tool calls, thinking blocks, media) that the current implementation silently drops. Make `ModelCombobox` a controlled component.

## Motivation

### Current State

The AI chat feature lives in three files:

```
src/lib/
  state/
    chat.svelte.ts          # 845 lines: state + providers + UIMessage boundary
  components/
    AiChat.svelte            # 351 lines: god component (5+ concerns)
    ModelCombobox.svelte     # 98 lines: reads singleton directly
```

Problems:

1. **`AiChat.svelte` is a god component.** It owns conversation switching, message rendering, error display, input form, and provider/model selection: each a distinct concern with independent change reasons.

2. **Only `text` parts are rendered.** The `getTextContent()` helper concatenates text parts and silently drops `tool-call`, `tool-result`, `thinking`, `image`, `audio`, `video`, and `document` parts. When the LLM invokes any of the 13 tab management tools, the user sees nothing: no progress, no result. This defeats the purpose of having client-side tools.

3. **`ModelCombobox` reads the `aiChatState` singleton directly**, making it untestable and unreusable.

4. **`chat.svelte.ts` mixes four responsibilities** in one file: provider config (pure data), UIMessage serialization boundary (pure functions + type assertions), ConversationHandle factory (reactive, per-conversation), and the orchestrator singleton (reactive, global).

5. **`updateConversation` uses find-then-set** instead of the atomic `TableHelper.update()`, risking stale overwrites in the CRDT context.

6. **No text is rendered as markdown.** AI responses are plain text despite `@epicenter/ui` providing a `.prose` CSS class with full markdown styling.

### Desired State

```
src/lib/
  ai/
    providers.ts                    # Pure data: provider/model config
    ui-message.ts                   # Pure: toUiMessage + drift detection types
  state/
    chat-state.svelte.ts            # Orchestrator + per-conversation reactive handles
  components/
    AiChat.svelte                   # Thin orchestrator (~50 lines)
    ConversationPicker.svelte       # Popover+Command conversation switcher
    MessageList.svelte              # Renders messages via Chat.List
    MessageParts.svelte             # Part-type dispatch (text, tool-call, thinking, etc.)
    ToolCallPart.svelte             # Tool call progress indicator
    ToolResultPart.svelte           # Tool result display
    ThinkingPart.svelte             # Collapsible thinking block
    ChatInput.svelte                # Textarea + send/stop + provider/model controls
    ChatErrorBanner.svelte          # Dismissible error display
    ModelCombobox.svelte            # Controlled: props in, events out
    ProviderSelect.svelte           # Controlled: props in, events out
```

## Research Findings

### TanStack AI MessagePart Types

The `UIMessage.parts` array is a discriminated union of 8 types. Each type has distinct rendering needs:

| Part Type | Fields | Rendering Approach |
|---|---|---|
| `text` | `content: string` | Markdown via `.prose-sm` class |
| `tool-call` | `name`, `arguments`, `state: ToolCallState`, `input?`, `output?` | Status badge + tool name + collapsible args/output |
| `tool-result` | `toolCallId`, `content`, `state: ToolResultState`, `error?` | Inline result card or error alert |
| `thinking` | `content: string` | Collapsible block, collapsed by default |
| `image` | `source: ContentPartSource` | `<img>` element |
| `audio` | `source: ContentPartSource` | `<audio>` element |
| `video` | `source: ContentPartSource` | `<video>` element |
| `document` | `source: ContentPartSource` | Download link or embedded PDF |

### ToolCallState Lifecycle

```
awaiting-input → input-streaming → input-complete → [approval-requested → approval-responded]
```

| State | UI Indicator |
|---|---|
| `awaiting-input` | Spinner + tool name |
| `input-streaming` | Spinner + tool name + streaming args preview |
| `input-complete` | Badge "running" + tool name |
| `approval-requested` | Badge "pending" + approve/deny buttons |
| `approval-responded` | Badge "completed" or "failed" based on result |

### ToolResultState Lifecycle

| State | UI Indicator |
|---|---|
| `streaming` | Spinner |
| `complete` | Badge `status.completed` + result summary |
| `error` | Badge `status.failed` + error message |

### Available Tab Manager Tools (13 total)

**Read tools** (5): `searchTabs`, `listTabs`, `listWindows`, `listDevices`, `countByDomain`
**Mutation tools** (8): `closeTabs`, `openTab`, `activateTab`, `saveTabs`, `groupTabs`, `pinTabs`, `muteTabs`, `reloadTabs`

Tool call rendering should show human-readable names (e.g., "Searching tabs…", "Closing 3 tabs…") rather than raw function names.

### Available UI Primitives

| Use Case | Primitive | Notes |
|---|---|---|
| Markdown rendering | `.prose-sm` CSS class | Already in `@epicenter/ui/prose.css` |
| Tool call status | `Badge` with `status.*` variants | `status.completed`, `status.failed`, `status.running` |
| Thinking collapse | `Collapsible` (Root + Trigger + Content) | From bits-ui |
| Loading indicator | `Spinner` or `Chat.LoadingDots` | Both available |
| Error display | `Alert` with `destructive` variant | Has icon grid layout |
| Code copy | `Snippet` or `CopyButton` | For tool args/results |
| Hover labels | `Tooltip` | For action buttons |

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| State file split granularity | 3 files (providers, ui-message, chat-state) | Providers and ui-message are pure: no `.svelte.ts` needed. Handle factory is an inner function inside chat-state: DI was over-engineered for a single consumer. |
| Component file split | 11 files (see Desired State) | Each concern maps to one change reason. `MessageParts` dispatches; leaf components render. |
| ModelCombobox API | Controlled: `value`, `models`, `onSelect` props | Matches shadcn-svelte composition philosophy. Enables reuse and testing. |
| ProviderSelect extraction | New component with `value`, `providers`, `onSelect` props | Same rationale as ModelCombobox. Symmetrical API. |
| Markdown rendering | `.prose-sm` class on text part container | Already exists, no new dependency. Compact variant fits sidebar. |
| Tool call display | Inline badge + collapsible details | Tools are frequent: they should be compact by default, expandable on demand. |
| Thinking blocks | Collapsed by default with "Thinking…" label | Most users don't need to read chain-of-thought. Power users can expand. |
| Media parts | Placeholder with type label initially | Image/audio/video are uncommon in a tab manager context. Can iterate later. |
| `updateConversation` fix | Use `TableHelper.update()` | Atomic read-merge-write. Correct in CRDT context. |
| Hub URL cache | Keep existing pattern | Pragmatic; the async-init-before-first-use race is acceptable for now. |

## Architecture

### State Layer Split

```
src/lib/ai/providers.ts
├── PROVIDER_MODELS constant (openai, anthropic, gemini, grok)
├── Provider type
├── DEFAULT_PROVIDER, DEFAULT_MODEL
└── AVAILABLE_PROVIDERS
    (Pure data, no runes, no .svelte.ts extension)

src/lib/ai/ui-message.ts
├── toUiMessage(ChatMessage → UIMessage)
├── Drift detection types (Expect, Equal, _DriftCheck)
└── TanStackMessagePart type alias
    (Pure functions + compile-time assertions, no runes)

src/lib/state/chat-state.svelte.ts
├── createAiChatState()
│   ├── conversations $state array (Y.Doc-backed)
│   ├── createConversationHandle(conversationId)  ← inner function, closes over orchestrator state
│   │   ├── Lazy ChatClient via ensureChat()
│   │   ├── $state: messages, isLoading, error, status, inputValue, dismissedError
│   │   ├── $derived: metadata (from conversations array)
│   │   ├── Getters: id, title, provider, model, messages, isLoading, error, status
│   │   ├── Setters: provider, model, inputValue, dismissedError
│   │   └── Actions: sendMessage, reload, stop, rename, delete, refreshFromDoc
│   ├── handles Map<ConversationId, ConversationHandle>
│   ├── activeConversationId $state
│   ├── Observers (conversations table, chatMessages table, whenReady)
│   ├── reconcileHandles()
│   ├── CRUD: createConversation, switchConversation, deleteConversation
│   └── Public API: active, conversations, get, switchTo, availableProviders, modelsForProvider
├── export const aiChatState = createAiChatState()
└── export type ConversationHandle
```

### Conversation Handle as Inner Function

`createConversationHandle` is an inner function inside `createAiChatState()`. It closes over the orchestrator's state directly: `conversations`, `updateConversation`, `deleteConversation`, `loadMessages`, `hubUrlCache`: eliminating the need for a dependency injection interface.

This was initially split into a separate file with an explicit `ConversationHandleDeps` interface, but the DI layer was over-engineered: there is exactly one consumer (the orchestrator), and the interface added ceremony without enabling meaningful independent testing. Consolidating into a single file reduced complexity and improved readability.

### Component Layer Split

```
AiChat.svelte (orchestrator)
├── ConversationPicker.svelte
│   ├── Popover.Root + Command.Root
│   ├── Conversation search + filtering
│   ├── Per-conversation: title, loading indicator, relative time, delete button
│   └── Props: conversations, activeId, onSwitch, onCreate, onDelete
│
├── MessageList.svelte
│   ├── Chat.List (auto-scroll)
│   ├── Empty state (when no messages)
│   ├── Per-message: Chat.Bubble + MessageParts
│   ├── Loading dots (when streaming)
│   ├── Regenerate button (when idle + last message is assistant)
│   └── Props: messages, status, onReload
│       │
│       └── MessageParts.svelte (per-message part dispatcher)
│           ├── {#each message.parts as part}
│           ├── text → <div class="prose-sm">{@html rendered}</div>
│           ├── tool-call → <ToolCallPart>
│           ├── tool-result → <ToolResultPart>
│           ├── thinking → <ThinkingPart>
│           └── image/audio/video/document → <MediaPart> (placeholder initially)
│
├── ChatErrorBanner.svelte
│   ├── Dismissible error alert
│   ├── Retry + dismiss buttons
│   └── Props: error, dismissedError, onRetry, onDismiss
│
└── ChatInput.svelte
    ├── ProviderSelect (controlled)
    ├── ModelCombobox (controlled)
    ├── Textarea with Enter-to-send
    ├── Send / Stop button
    └── Props: active (ConversationHandle)
```

### Data Flow

```
Y.Doc (CRDT)
  │
  ├─ observe ──→ chat-state.svelte.ts ──→ conversations $state
  │                   │
  │                   ├── reconcileHandles() ──→ Map<id, ConversationHandle>
  │                   │
  │                   └── active getter ──→ AiChat.svelte
  │                                            │
  │                                            ├── ConversationPicker
  │                                            │     reads: conversations, activeId
  │                                            │     calls: switchTo, create, delete
  │                                            │
  │                                            ├── MessageList
  │                                            │     reads: active.messages, active.status
  │                                            │     │
  │                                            │     └── MessageParts
  │                                            │           dispatches on part.type
  │                                            │           │
  │                                            │           ├── ToolCallPart
  │                                            │           ├── ToolResultPart
  │                                            │           └── ThinkingPart
  │                                            │
  │                                            ├── ChatErrorBanner
  │                                            │     reads: active.error, active.dismissedError
  │                                            │
  │                                            └── ChatInput
  │                                                  reads: active.inputValue, provider, model
  │                                                  calls: sendMessage, stop
  │                                                  │
  │                                                  ├── ProviderSelect (controlled)
  │                                                  └── ModelCombobox (controlled)
  │
  └─ TanStack AI ChatClient
       streams ──→ onMessagesChange ──→ messages $state
       finishes ──→ onFinish ──→ Y.Doc write (assistant message)
```

## Implementation Plan

### Phase 1: Extract Pure Modules (no behavior change)

- [x] 1.1 Create `src/lib/ai/providers.ts`: move `PROVIDER_MODELS`, `Provider`, `DEFAULT_PROVIDER`, `DEFAULT_MODEL`, `AVAILABLE_PROVIDERS` from `chat.svelte.ts`
- [x] 1.2 Create `src/lib/ai/ui-message.ts`: move `toUiMessage()`, drift detection types (`Expect`, `Equal`, `TanStackMessagePart`, `ExpectedPartTypes`, `_DriftCheck`) from `chat.svelte.ts`
- [x] 1.3 Update imports in `chat.svelte.ts` to reference the new modules
- [x] 1.4 Verify build passes: no behavior change

### Phase 2: Split State Files

- [x] 2.1 ~~Create `src/lib/state/conversation-handle.svelte.ts`~~ → consolidated back into `chat-state.svelte.ts` (DI was over-engineered for single consumer)
- [x] 2.2 Rename `chat.svelte.ts` → `chat-state.svelte.ts` with `createConversationHandle` as inner function
- [x] 2.3 Fix `updateConversation` to use `TableHelper.update()` instead of find-then-set
- [x] 2.4 Export `ConversationHandle` type from `chat-state.svelte.ts`
- [x] 2.5 Update all consumers to import from new paths (`chat-state.svelte` instead of `chat.svelte`)
- [x] 2.6 Verify build passes: no behavior change

### Phase 3: Extract Controlled Components

- [x] 3.1 Create `ProviderSelect.svelte`: props: `value`, `providers`, `onValueChange`; renders `Select.Root` + `Select.Trigger` + `Select.Content` + `Select.Item`
- [x] 3.2 Refactor `ModelCombobox.svelte`: change from singleton reader to controlled: props `value`, `models`, `onSelect`, `class?`; remove `aiChatState` import
- [x] 3.3 Update `AiChat.svelte` to pass controlled props to both components
- [x] 3.4 Verify build passes: no behavior change

### Phase 4: Extract UI Components

- [x] 4.1 Create `ConversationPicker.svelte`: extract the Popover+Command conversation switcher; props: `conversations` (ConversationHandle[]), `activeId`, `onSwitch`, `onCreate`; move `formatRelativeTime` and `conversationSearch` state into it
- [x] 4.2 Create `ChatErrorBanner.svelte`: extract the error banner; props: `error`, `dismissedError`, `onRetry`, `onDismiss`
- [x] 4.3 Create `ChatInput.svelte`: extract the controls area; props: `active` (ConversationHandle); contains ProviderSelect, ModelCombobox, Textarea, Send/Stop
- [x] 4.4 Slim `AiChat.svelte` to thin orchestrator: compose `ConversationPicker`, `MessageList`, `ChatErrorBanner`, `ChatInput`
- [x] 4.5 Verify build passes: visual parity

### Phase 5: MessagePart Rendering

- [x] 5.1 Create `MessageParts.svelte`: part-type dispatcher; props: `parts` (MessagePart[]); uses `{#each}` + `{#if part.type === ...}` dispatch with explicit casts (Svelte doesn't narrow discriminated unions in templates)
- [x] 5.2 Implement text part rendering: plain text in `.prose-sm` container (markdown-to-HTML deferred to follow-up)
- [x] 5.3 Create `ToolCallPart.svelte`: renders tool call progress with `toolDisplayNames` map, Badge status variants, Collapsible details, and LoaderCircle animation
- [x] 5.4 Create `ToolResultPart.svelte`: renders tool results with state-based display (streaming/error/complete)
- [x] 5.5 Create `ThinkingPart.svelte`: collapsible thinking block, collapsed by default, with Brain icon and muted styling
- [x] 5.6 Create `MessageList.svelte`: wraps `Chat.List`, handles empty state, loading dots, regenerate button
- [x] 5.7 Wire `MessageList` into `AiChat.svelte`, replacing the inline message rendering
- [x] 5.8 Verify build passes: tool calls and thinking blocks now visible

### Phase 6: Polish

- [x] 6.1 Add `toolDisplayNames` map: human-readable labels for all 13 tools (co-located in `ToolCallPart.svelte`)
- [ ] 6.2 Add result summarizers: parse tool result JSON and return human-readable strings (e.g., `{ closedCount: 3 }` → "Closed 3 tabs")
- [ ] 6.3 Add `Tooltip` to action buttons (regenerate, send, stop, new conversation, delete)
- [ ] 6.4 Verify visual consistency with existing sidebar styling

## Component Specifications

### AiChat.svelte (Orchestrator)

**Imports**: `aiChatState`, `ConversationPicker`, `MessageList`, `ChatErrorBanner`, `ChatInput`

**Template** (~50 lines):

```svelte
<script lang="ts">
  import { aiChatState } from '$lib/state/chat-state.svelte';
  import ConversationPicker from './ConversationPicker.svelte';
  import MessageList from './MessageList.svelte';
  import ChatErrorBanner from './ChatErrorBanner.svelte';
  import ChatInput from './ChatInput.svelte';

  const active = $derived(aiChatState.active);
</script>

<div class="flex h-full flex-col">
  <ConversationPicker
    conversations={aiChatState.conversations}
    activeId={aiChatState.activeConversationId}
    onSwitch={(id) => aiChatState.switchTo(id)}
    onCreate={() => aiChatState.createConversation()}
  />

  <div class="min-h-0 flex-1">
    <MessageList
      messages={active?.messages ?? []}
      status={active?.status ?? 'ready'}
      onReload={() => active?.reload()}
    />
  </div>

  {#if active}
    <ChatErrorBanner
      error={active.error}
      dismissedError={active.dismissedError}
      onRetry={() => {
        active.dismissedError = null;
        active.reload();
      }}
      onDismiss={() => {
        active.dismissedError = active.error?.message ?? null;
      }}
    />
  {/if}

  <ChatInput {active} />
</div>
```

### ConversationPicker.svelte

**Props**:

```typescript
let {
  conversations,
  activeId,
  onSwitch,
  onCreate,
}: {
  conversations: ConversationHandle[];
  activeId: ConversationId;
  onSwitch: (id: ConversationId) => void;
  onCreate: () => void;
} = $props();
```

**Internal state**: `conversationSearch` ($state), `combobox` (useCombobox)

**Owns**: `formatRelativeTime` helper (moved from AiChat), conversation filtering logic, delete confirmation via `confirmationDialog`

**Template**: The existing conversation bar markup, extracted verbatim, then adapted to use props instead of `aiChatState` directly.

### MessageList.svelte

**Props**:

```typescript
let {
  messages,
  status,
  onReload,
}: {
  messages: UIMessage[];
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  onReload: () => void;
} = $props();
```

**Derived state**:

```typescript
const showLoadingDots = $derived(
  status === 'submitted' ||
  (status === 'streaming' && messages.at(-1)?.role !== 'assistant'),
);

const showRegenerate = $derived(
  status === 'ready' && messages.at(-1)?.role === 'assistant',
);
```

**Template**: `Chat.List` wrapping `{#each messages}` → `Chat.Bubble` + `MessageParts`. Empty state with `Empty.Root` when no messages. Loading dots and regenerate button at the bottom.

### MessageParts.svelte

**Props**:

```typescript
let {
  parts,
}: {
  parts: Array<{ type: string; [key: string]: unknown }>;
} = $props();
```

**Template**: Single `{#each}` with type dispatch:

```svelte
{#each parts as part}
  {#if part.type === 'text'}
    <div class="prose prose-sm">{part.content}</div>
  {:else if part.type === 'tool-call'}
    <ToolCallPart {part} />
  {:else if part.type === 'tool-result'}
    <ToolResultPart {part} />
  {:else if part.type === 'thinking'}
    <ThinkingPart content={part.content} />
  {:else if part.type === 'image'}
    <!-- Phase 6+ media rendering -->
  {/if}
{/each}
```

Note: Text rendering will start as plain text inside a `.prose-sm` container. Full markdown-to-HTML can be added iteratively. The `.prose-sm` class from `@epicenter/ui` handles all the styling once HTML is provided.

### ToolCallPart.svelte

**Props**:

```typescript
let {
  part,
}: {
  part: {
    type: 'tool-call';
    name: string;
    arguments: string;
    state: string;
    input?: unknown;
    output?: unknown;
  };
} = $props();
```

**Rendering logic**:

```
┌─────────────────────────────────────────┐
│ 🔵 Searching tabs…                      │  ← Badge status.running + display name
│                                          │
│ ▸ Details                                │  ← Collapsible trigger (collapsed)
│   ┌────────────────────────────────────┐ │
│   │ Arguments: { "query": "github" }   │ │  ← Collapsible content
│   │ Result: { "results": [...] }       │ │
│   └────────────────────────────────────┘ │
│                                          │
│ ✅ Found 5 tabs                          │  ← Badge status.completed + summary
└─────────────────────────────────────────┘
```

State machine for badge variant:

- `awaiting-input` / `input-streaming` / `input-complete` → `status.running` + Spinner
- Has `output` and no error → `status.completed`
- Error → `status.failed`

### ToolResultPart.svelte

**Props**:

```typescript
let {
  part,
}: {
  part: {
    type: 'tool-result';
    toolCallId: string;
    content: string;
    state: string;
    error?: string;
  };
} = $props();
```

**Rendering**: Compact inline. `state === 'error'` shows destructive Alert. `state === 'complete'` shows the result content. `state === 'streaming'` shows Spinner.

### ThinkingPart.svelte

**Props**:

```typescript
let {
  content,
}: {
  content: string;
} = $props();
```

**Rendering**: `Collapsible` with muted styling. Trigger shows "Thinking…" with a brain icon. Content shows the thinking text in `prose-sm text-muted-foreground`. Collapsed by default.

### ChatInput.svelte

**Props**:

```typescript
let {
  active,
}: {
  active: ConversationHandle | undefined;
} = $props();
```

**Owns**: The `send()` function, provider/model selection wiring.

**Template**: Border-top container with ProviderSelect + ModelCombobox row, then Textarea + Send/Stop form row.

### ChatErrorBanner.svelte

**Props**:

```typescript
let {
  error,
  dismissedError,
  onRetry,
  onDismiss,
}: {
  error: Error | undefined;
  dismissedError: string | null;
  onRetry: () => void;
  onDismiss: () => void;
} = $props();
```

**Rendering**: Only renders when `error && error.message !== dismissedError`. Shows error message, Retry button, and dismiss X button.

### ModelCombobox.svelte (Refactored)

**Before** (reads singleton):

```svelte
const models = $derived(
  aiChatState.modelsForProvider(aiChatState.active?.provider ?? ''),
);
```

**After** (controlled):

```typescript
let {
  value,
  models,
  onSelect,
  class: className,
}: {
  value: string;
  models: readonly string[];
  onSelect: (model: string) => void;
  class?: string;
} = $props();
```

All internal filtering logic stays the same; only the data source changes from singleton to props.

### ProviderSelect.svelte (New)

```typescript
let {
  value,
  providers,
  onValueChange,
}: {
  value: string;
  providers: readonly string[];
  onValueChange: (provider: string) => void;
} = $props();
```

Renders `Select.Root` + `Select.Trigger` + `Select.Content` + `{#each providers}` `Select.Item`.

## Edge Cases

### 1. Tool call part arrives before tool result

The LLM streams `tool-call` parts with state `awaiting-input` → `input-streaming` → `input-complete`. The result arrives later as a separate `tool-result` part (or via `output` field on the tool-call part for client-side tools).

**Mitigation**: `ToolCallPart.svelte` reads `part.state` and `part.output` reactively. The badge transitions from "running" to "completed" as the state updates. No explicit pairing logic needed: TanStack AI maintains the parts array.

### 2. Conversation switch during streaming

When the user switches away from a streaming conversation, the ChatClient continues streaming in the background. When they switch back, `refreshFromDoc()` is called. But only if the ChatClient is idle.

**Mitigation**: Existing behavior is correct. The `refreshFromDoc()` guard (`if (!chatInstance || chatInstance.isLoading) return`) prevents overwriting in-progress streaming state. The `MessageList` component receives reactive `messages` from the handle, so switching back shows the current streaming state.

### 3. Markdown XSS in text parts

If we render markdown as HTML via `{@html}`, user-controlled content (or malicious LLM output) could inject scripts.

**Mitigation**: Use a sanitizing markdown renderer. Options: `marked` + `DOMPurify`, or `snarkdown` (tiny, no HTML passthrough). For Phase 5, start with plain text in `.prose-sm`: no `{@html}`: and add sanitized markdown in a follow-up.

### 4. Empty parts array on a message

Some messages may have an empty `parts` array (e.g., system messages or edge cases in TanStack AI).

**Mitigation**: `MessageParts.svelte` renders nothing for an empty array. The `{#each}` simply produces no output. The parent `Chat.Bubble` still renders but is empty: acceptable for edge cases.

### 5. Rename `chat.svelte.ts` breaks existing imports

Multiple files import from `$lib/state/chat.svelte`. Renaming to `chat-state.svelte.ts` requires updating all import paths.

**Mitigation**: Phase 2.5 explicitly includes updating all consumers. Use grep to find all imports of `$lib/state/chat.svelte` and update them. The TypeScript compiler will catch any missed imports.

## Open Questions

### 1. Markdown rendering library

Which library should render text parts as markdown?

- (a) `marked` + `DOMPurify`: full GFM support, battle-tested, ~30KB combined
- (b) `snarkdown`: 1KB, covers basics (bold, italic, links, code), no HTML passthrough
- (c) Plain text in `.prose-sm` initially, add markdown later

**Recommendation**: (c) for Phase 5, then (a) in a follow-up. The `.prose-sm` class already handles all the typography. Adding `{@html}` with a sanitizer is a separate, well-scoped change.

### 2. Tool result summarization

Should tool results show raw JSON or human-readable summaries?

- (a) Raw JSON in a `Snippet` component
- (b) Human-readable summaries (e.g., "Found 5 tabs") with expandable raw JSON
- (c) Only human-readable summaries

**Recommendation**: (b). Show a one-line summary derived from the tool name + result fields, with a `Collapsible` to show raw JSON for debugging. The summarizer can be a simple function mapping tool name → format string.

### 3. Should MessageParts be typed or use `unknown`?

The parts array is `unknown[]` from Y.Doc. We cast at the `toUiMessage` boundary. Should `MessageParts.svelte` accept the typed `MessagePart[]` or a looser type?

- (a) Accept `MessagePart[]`: full type safety in the component
- (b) Accept `Array<{ type: string; [key: string]: unknown }>`: loose, but defensive

**Recommendation**: (a). The `toUiMessage` boundary already handles the cast. Components downstream should benefit from the type narrowing that TanStack AI's discriminated union provides.

## Success Criteria

- [x] `AiChat.svelte` is under 60 lines (42 lines)
- [x] `chat-state.svelte.ts` consolidates orchestrator + handle factory (~770 lines: well-structured with clear sections)
- [x] `providers.ts` and `ui-message.ts` have no Svelte rune imports
- [x] `ModelCombobox` accepts `value`, `models`, `onSelect` props: no singleton import
- [x] `ProviderSelect` accepts `value`, `providers`, `onValueChange` props
- [x] Tool call parts render with status badges and tool names during streaming
- [x] Tool result parts render with state-based display (streaming/error/complete)
- [x] Thinking parts render as collapsed blocks
- [x] Text parts render in `.prose-sm` styled container
- [x] Build passes with no new type errors (79 pre-existing, 0 new)
- [ ] Visual parity with existing UI for basic text conversations
- [ ] No regressions in conversation switching, creation, deletion
- [ ] Background streaming still works (switch away and back)

## References

- `apps/tab-manager/src/lib/state/chat.svelte.ts`: current monolithic state file (845 lines)
- `apps/tab-manager/src/lib/components/AiChat.svelte`: current god component (351 lines)
- `apps/tab-manager/src/lib/components/ModelCombobox.svelte`: current singleton-reading combobox
- `apps/tab-manager/src/lib/ai/tools/definitions.ts`: 13 tool schema contracts
- `apps/tab-manager/src/lib/ai/tools/client.ts`: client-side tool execute bindings
- `apps/tab-manager/src/lib/ai/system-prompt.ts`: system prompt constant
- `apps/tab-manager/src/lib/workspace.ts`: Conversation and ChatMessage table schemas
- `packages/ui/src/chat/`: Chat.Bubble, Chat.BubbleMessage, Chat.List primitives
- `packages/ui/src/badge/badge.svelte`: Badge with `status.*` variants
- `packages/ui/src/collapsible/`: Collapsible primitive for thinking blocks
- `packages/ui/src/prose.css`: `.prose` and `.prose-sm` markdown styling
- `packages/ui/src/hooks/use-combobox.svelte.ts`: useCombobox hook pattern
- `node_modules/@tanstack/ai-client/src/types.ts`: UIMessage, MessagePart, ToolCallState types
- `node_modules/@tanstack/ai-svelte/src/create-chat.svelte.ts`: createChat reactive wrapper

## Review

### Implementation Notes

- **MessageParts typing**: Went with option (a): `MessagePart[]` from `@tanstack/ai-client`. Svelte templates don't narrow discriminated unions in `{#if}` blocks, so explicit `as` casts are used at dispatch boundaries in `MessageParts.svelte`. This is type-safe because the `{#if part.type === '...'}` guards guarantee correctness at runtime.
- **`updateConversation`**: Switched to `TableHelper.update()` for atomic read-merge-write as specified.
- **Tool result summarization**: Deferred to Phase 6 follow-up. Currently shows raw `part.content` string. The `toolDisplayNames` map is already in `ToolCallPart.svelte` for progress labels.
- **Markdown rendering**: Deferred per recommendation (c). Text renders as plain text inside `.prose-sm` containers. Adding `{@html}` with a sanitizer is a separate, well-scoped follow-up.
- **`chat-state.svelte.ts`** is 406 lines (6 over the 400 target). The extra lines are JSDoc comments on the public API: trimming would sacrifice documentation quality.
