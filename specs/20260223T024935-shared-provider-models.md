# Shared Provider Models

**Date**: 2026-02-23
**Status**: Draft
**Author**: AI-assisted

## Overview

Replace hardcoded AI model lists across the monorepo with imports from TanStack AI's maintained model arrays. Add a combobox-based model selector component to `@epicenter/ui` that lets users pick a known model or type a custom one.

## Motivation

### Current State

Model lists are duplicated with divergent data:

**Tab Manager**: hardcoded, outdated, 12 models:
```typescript
// apps/tab-manager/src/lib/state/ai-chat-state.svelte.ts
const PROVIDER_MODELS: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
  gemini: ['gemini-2.0-flash', 'gemini-2.5-pro'],
  ollama: ['llama3', 'mistral', 'codellama'],
  grok: ['grok-2', 'grok-2-mini'],
};
```

**Server**: accepts any string, types via TanStack AI imports:
```typescript
// packages/server/src/ai/adapters.ts
export type SupportedProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'grok';
```

This creates problems:

1. **Model drift**: Tab Manager models are outdated (missing gpt-5, gpt-4.1, etc.).
2. **Maintenance burden**: Every new model requires manual updates.
3. **No auto-update path**: All lists are hand-maintained.

### Desired State

```typescript
// Import directly from TanStack AI: no wrapper package
import { OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';
import { ANTHROPIC_MODELS } from '@tanstack/ai-anthropic';

// Update all apps by running: bun update @tanstack/ai-openai @tanstack/ai-anthropic ...
```

## Research Findings

### TanStack AI Exports

TanStack AI (v0.5.x) exports both **runtime constant arrays** and **type unions** from each provider package:

| Package | Exported Array | Exported Type | Count |
|---|---|---|---|
| `@tanstack/ai-openai` | `OPENAI_CHAT_MODELS` | `OpenAIChatModel` | 38 models |
| `@tanstack/ai-anthropic` | `ANTHROPIC_MODELS` | `AnthropicChatModel` | 10 models |
| `@tanstack/ai-gemini` | `GEMINI_MODELS` / `GeminiTextModels` | `GeminiTextModel` | 9 models |
| `@tanstack/ai-grok` | `GROK_CHAT_MODELS` | `GrokChatModel` | 9 models |
| `@tanstack/ai-ollama` | `OllamaTextModels` | `OllamaTextModel` | 60+ models |

These are pure `as const` arrays: tree-shakeable, no runtime overhead.

**Key finding**: No wrapper package needed. These ARE the shared constants. `bun update @tanstack/ai-*` updates model lists everywhere.

### Existing Combobox Pattern in Codebase

The `@epicenter/ui` package already has:
- `useCombobox()` hook in `packages/ui/src/hooks/use-combobox.svelte.ts`
- `Command.*` components in `packages/ui/src/command/`
- Popover + Command combobox pattern used in 8+ selectors across Whispering

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Shared location | Direct import from `@tanstack/ai-*` | No wrapper package needed. The npm packages ARE the shared constants. Zero indirection. |
| Groq provider | Drop from this work | No TanStack AI package. Only used in Whispering (Phase 3). Not needed for Tab Manager or Server. |
| Ollama models | Import from TanStack AI + allow freeform | TanStack AI has 60+ Ollama models. Combobox allows custom entries for user-installed models. |
| UI component | Combobox (Popover + Command) in `@epicenter/ui` | Existing pattern in codebase. Supports both list selection and freeform text input. Reusable by Whispering later. |

## Architecture

### Model Selector Component

A combobox that shows known models as suggestions but accepts any typed input:

```
+----------------------------------+
|  gpt-4o-mini                  v  |  <- Trigger shows current value
+----------------------------------+
+----------------------------------+
|  Search or type a model...       |  <- Editable Command.Input
|----------------------------------|
|  gpt-5.2                         |
|  gpt-5.2-pro                     |
|  gpt-5                           |
|  gpt-5-mini                      |
|  * gpt-4o-mini                   |  <- Currently selected
|  gpt-4.1                         |
|  ...                             |
|----------------------------------|
|  > Use "my-custom-model"         |  <- Shown when typed text not in list
+----------------------------------+
```

The component:
- Shows a filterable list of known models
- Allows freeform text entry (for custom/fine-tuned models)
- When the user types something not in the list, a "Use as custom model" option appears
- Works with the existing `useCombobox()` hook and `Command.*` components

## Implementation Plan

### Phase 1: ModelCombobox + Tab Manager

- [ ] **1.1** Add `@tanstack/ai-openai`, `@tanstack/ai-anthropic`, `@tanstack/ai-gemini`, `@tanstack/ai-grok`, `@tanstack/ai-ollama` to `apps/tab-manager/package.json`
- [ ] **1.2** Replace `PROVIDER_MODELS` in `apps/tab-manager/src/lib/state/ai-chat-state.svelte.ts` with direct imports from `@tanstack/ai-*`
- [ ] **1.3** Build `ModelCombobox.svelte` in `@epicenter/ui` using Popover + Command: accepts a model array prop and allows freeform text
- [ ] **1.4** Replace `Select.Root` model selector in `apps/tab-manager/src/lib/components/AiChat.svelte` with the new combobox
- [ ] **1.5** Verify type-check passes, tab-manager builds

### Phase 2: Server Alignment

- [ ] **2.1** Replace `SupportedProvider` type in `packages/server/src/ai/adapters.ts`: derive from the provider packages already imported there
- [ ] **2.2** Verify server builds and tests pass

### Phase 3: Whispering Migration (Separate Effort, Deferred)

- [ ] **3.1** Replace manually-maintained model files in `apps/whispering/src/lib/constants/inference/` with imports from `@tanstack/ai-*`
- [ ] **3.2** Update arktype validators in `transformation-steps.ts`
- [ ] **3.3** Update UI selectors

## Edge Cases

### User Types a Model Not in the List

1. User types "my-fine-tuned-gpt4" in the combobox
2. No match in the known models list
3. A "Use as custom model" option appears
4. Selecting it sets the model to the typed string
5. Invalid models fail at the provider API level with a descriptive error

### Model Type Widening for Freeform Input

`OPENAI_CHAT_MODELS` gives a narrow literal type like `"gpt-5" | "gpt-5-mini" | ...`. The combobox state should use `string` type (accepting any input), while the suggestion list uses the narrow type for autocomplete.

## Success Criteria

- [ ] Tab Manager imports model arrays directly from `@tanstack/ai-*`: no local hardcoded list
- [ ] Tab Manager model selector is a combobox supporting both list selection and freeform text
- [ ] Server's `SupportedProvider` is derived from imported packages, not manually maintained
- [ ] Running `bun update @tanstack/ai-openai` updates model lists everywhere
- [ ] All apps build and typecheck cleanly

## References

- `apps/tab-manager/src/lib/state/ai-chat-state.svelte.ts`: Current model definitions (to be replaced)
- `apps/tab-manager/src/lib/components/AiChat.svelte`: Current model selector UI (to be updated)
- `packages/server/src/ai/adapters.ts`: Server adapter factories and `SupportedProvider` type
- `packages/ui/src/hooks/use-combobox.svelte.ts`: Existing combobox hook
- `packages/ui/src/command/`: Existing Command components
- `apps/whispering/src/lib/components/settings/selectors/TranscriptionSelector.svelte`: Reference combobox implementation
