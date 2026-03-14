# Action Metadata: `title` and `destructive` Fields

**Date**: 2026-03-12
**Status**: Implemented
**Author**: AI-assisted

## Overview

Add `title` (optional string) and `destructive` (optional boolean, default `false`) to the action definition system. These fields flow through the tool bridge to TanStack AI and MCP consumers, replace the underscore-to-space regex hack in `ToolCallPart.svelte`, and enable future command palette unification.

## Motivation

### Current State

Actions carry minimal metadata—just `description` and `input`:

```typescript
// packages/workspace/src/shared/actions.ts
type ActionConfig<TInput, TOutput> = {
    description?: string;
    input?: TInput;
    handler: ActionHandler<TInput, TOutput>;
};
```

The tool bridge derives display names from the path:

```typescript
// packages/ai/src/tool-bridge.ts line 144
description: action.description ?? `${action.type}: ${path.join('.')}`,
```

And the UI hacks around the lack of a title:

```typescript
// apps/tab-manager ToolCallPart.svelte line 22
const displayName = $derived(
    part.name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
);
// tabs_close → "Tabs close" — not even properly capitalized
```

Meanwhile, a parallel `QuickAction` system has the metadata we need but is completely disconnected from `.withActions()`:

```typescript
// apps/tab-manager/src/lib/quick-actions.ts
type QuickAction = {
    id: string;
    label: string;        // ← We need this on actions
    description: string;
    icon: Component;
    keywords: string[];
    execute: () => Promise<void> | void;
    dangerous?: boolean;  // ← We need this on actions
};
```

This creates problems:

1. **No human-readable title**: `tabs_close` is not a display name. The regex produces "Tabs close" instead of "Close Tabs."
2. **No destructive flag on actions**: The tool bridge blanket-marks all mutations as `needsApproval` via an option, with no per-action control. Quick actions have `dangerous` but it's in a separate system.
3. **Two disconnected systems**: Quick actions (command palette) and workspace actions (AI tools) define overlapping functionality with zero shared metadata.

### Desired State

```typescript
tabs: {
    close: defineMutation({
        title: 'Close Tabs',
        description: 'Close one or more tabs by their composite IDs.',
        destructive: true,
        input: Type.Object({ tabIds: Type.Array(Type.String()) }),
        handler: async ({ tabIds }) => { /* ... */ },
    }),
}
```

- `title` flows to the UI, MCP `annotations.title`, and tool descriptions
- `destructive` maps to `needsApproval` in the tool bridge and `destructiveHint` in MCP
- `ToolCallPart.svelte` uses the title directly—no regex

## Research Findings

### Ecosystem Naming Conventions

| System | Display Name | Danger Flag | Category |
|---|---|---|---|
| MCP `ToolAnnotations` | `title` (optional) | `destructiveHint` (boolean, default `true` for non-read-only) | None |
| TanStack AI `ClientTool` | None (only `name` + `description`) | `needsApproval` (boolean) | None |
| VS Code Commands | `title` (required) | None | `category` (string) |
| Hono/OpenAPI | None | None | `tags` (string[]) |
| shadcn-svelte UI components | N/A | `variant: 'destructive'` | N/A |
| Epicenter `QuickAction` | `label` | `dangerous` | None |

**Key findings:**

- **`title`** is the standard name across MCP and VS Code. Not `label`, not `displayName`.
- **`destructive`** aligns with the UI layer (`variant: 'destructive'`) and maps cleanly to MCP's `destructiveHint`. It describes the nature of the action, not the UX behavior.
- **`needsApproval`** is a consumer concern (tool bridge), not an action property. The action says "I'm destructive"; the bridge decides whether that means "show confirmation."
- **`category`** is redundant—the action tree nesting already provides this (`tabs.close` → category `tabs`).
- **`keywords`** deferred—command palette can search `title + description + path` effectively without a dedicated field.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Display name field | `title` | MCP and VS Code precedent. Not `label` (too UI-specific) or `displayName` (verbose) |
| `title` optionality | Optional | Falls back to path-derived name if omitted. Matches MCP where `title` is optional |
| Danger field | `destructive` | Matches UI `variant: 'destructive'`, maps to MCP `destructiveHint` |
| `destructive` default | `false` | Only 2 of 13 current actions are destructive. Opt-in is less noisy |
| `category` field | Not added | Path nesting is the category. `tabs.close` → category `tabs` |
| `keywords` field | Not added | Search on `title + description + path` is sufficient for now |
| `needsApproval` mapping | `destructive: true` → `needsApproval: true` in tool bridge | Keeps action system clean; approval is a consumer concern |
| Tool bridge `description` | Use `description` (keep existing behavior) | `title` is short ("Close Tabs"), `description` gives the LLM context ("Close one or more tabs by their composite IDs"). The LLM needs the longer form |

## Architecture

```
ActionConfig                              Consumer Surfaces
┌──────────────────────┐
│ title?               │──► ToolCallPart.svelte (display name)
│ description?         │──► actionsToClientTools → LLM description
│ destructive?         │──► actionsToClientTools → needsApproval
│ input?               │──► actionsToClientTools → inputSchema
│ handler              │──► actionsToClientTools → execute
└──────────────────────┘
         │
         ▼ iterateActions()
┌──────────────────────┐
│ ActionDescriptor     │
│ ├── title?           │──► MCP annotations.title
│ ├── description?     │──► MCP tool description
│ ├── destructive?     │──► MCP annotations.destructiveHint
│ ├── path             │──► MCP tool name
│ └── input?           │──► MCP inputSchema
└──────────────────────┘
```

## Implementation Plan

### Phase 1: Core Types (packages/workspace)

- [x] **1.1** Add `title?: string` and `destructive?: boolean` to `ActionConfig` type in `packages/workspace/src/shared/actions.ts`
- [x] **1.2** Add `title?: string` and `destructive?: boolean` to `ActionMeta` type in the same file
- [x] **1.3** Update `defineQuery` and `defineMutation` implementations to forward the new fields via `...rest` spread (already handled—`{ handler, ...rest }` captures them)
- [x] **1.4** Add `title?: string` and `destructive?: boolean` to `ActionDescriptor` type in `packages/workspace/src/workspace/describe-workspace.ts`
- [x] **1.5** Update `describeWorkspace` to include `title` and `destructive` in the descriptor output

### Phase 2: Tool Bridge (packages/ai)

- [x] **2.1** Update `actionsToClientTools` in `packages/ai/src/tool-bridge.ts` to: set `needsApproval: true` when `action.destructive` is true (per-action override, in addition to existing blanket `requireApprovalForMutations` option)
- [x] **2.2** Update `ToolDefinitionPayload` to include optional `title` field
- [x] **2.3** Update `toToolDefinitions` to forward `title` from the client tool metadata

### Phase 3: Tab Manager Actions (apps/tab-manager)

- [x] **3.1** Add `title` to every action in `.withActions()` in `apps/tab-manager/src/lib/workspace.ts`
- [x] **3.2** Add `destructive: true` to `tabs.close` action
- [x] **3.3** Review `tabs.save`—it's only destructive when `close: true`, so leave as non-destructive (the `close` flag is an input parameter, not a static property)

### Phase 4: UI Consumers (apps/tab-manager)

- [x] **4.1** Update `ToolCallPart.svelte` to use the tool's title metadata instead of the `replace(/_/g, ' ')` regex. The tool bridge needs to make title available on the tool call part—check how TanStack AI `ToolCallPart` exposes tool metadata and find the right path to surface it
- [x] **4.2** If TanStack AI's `ToolCallPart` doesn't carry tool metadata, create a lookup map from `workspaceTools` (name → title) and import it in `ToolCallPart.svelte`

### Phase 5: Tests

- [x] **5.1** Update `describe-workspace.test.ts` to verify `title` and `destructive` appear in the descriptor
- [x] **5.2** Add a test case for `actionsToClientTools` verifying `destructive: true` → `needsApproval: true`
- [x] **5.3** Run `bun test` and `bun run typecheck` to verify no regressions

## Edge Cases

### `destructive` on `tabs.save`

1. `tabs.save` accepts `close: true` as an input parameter
2. When `close: true`, the action is destructive (closes tabs after saving)
3. But `destructive` is a static property, not input-dependent
4. **Decision**: Leave `tabs.save` as non-destructive. The AI tool calling approval flow handles this at the `requireApprovalForMutations` level. If per-invocation approval is needed later, that's a TanStack AI concern.

### `title` omitted

1. An action has no `title` set
2. `ToolCallPart.svelte` falls back to the existing path-derived name
3. `describeWorkspace` omits `title` from the descriptor (same pattern as `description`)
4. **No breaking change**—`title` is optional everywhere

### Tool bridge `needsApproval` precedence

1. `requireApprovalForMutations: true` (blanket option) already marks all mutations
2. `destructive: true` on a specific action should ALSO set `needsApproval: true`
3. These are additive—`needsApproval` is true if EITHER condition is met
4. A query with `destructive: true` (unusual but valid) would get `needsApproval: true`

## Open Questions

1. **Should `title` influence the tool `description` sent to the LLM?**
   - Currently: `description` field goes to LLM as-is
   - Option A: Keep `description` as LLM description (current behavior)
   - Option B: Prefix with title: `"Close Tabs — Close one or more tabs by their composite IDs."`
   - **Recommendation**: Option A. The LLM doesn't need the title—it has the tool name and description. Title is for human display.

2. **How does `ToolCallPart.svelte` access the title?**
   - TanStack AI's `ToolCallPart` type has `name`, `arguments`, `output` but likely not arbitrary metadata
   - **Recommendation**: Create a simple lookup map `Record<string, string>` from `workspaceTools` in workspace.ts, import it in ToolCallPart. Cheap, explicit, no framework gymnastics.

## Success Criteria

- [ ] `ActionConfig` accepts `title` and `destructive` with correct types
- [ ] `defineQuery` / `defineMutation` forward the new fields to `ActionMeta`
- [ ] `describeWorkspace` includes `title` and `destructive` in output
- [ ] `actionsToClientTools` maps `destructive: true` → `needsApproval: true`
- [ ] All 13 tab-manager actions have `title` set
- [ ] `tabs.close` has `destructive: true`
- [ ] `ToolCallPart.svelte` displays action title instead of regex-derived name
- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] No `as any` or `@ts-ignore` introduced

## References

- `packages/workspace/src/shared/actions.ts` — ActionConfig, ActionMeta, defineQuery, defineMutation
- `packages/workspace/src/workspace/describe-workspace.ts` — ActionDescriptor, describeWorkspace
- `packages/workspace/src/workspace/describe-workspace.test.ts` — Descriptor tests
- `packages/ai/src/tool-bridge.ts` — actionsToClientTools, toToolDefinitions, ToolDefinitionPayload
- `apps/tab-manager/src/lib/workspace.ts` — All 13 action definitions, workspaceTools export
- `apps/tab-manager/src/lib/components/chat/ToolCallPart.svelte` — Regex display name hack
- `apps/tab-manager/src/lib/quick-actions.ts` — QuickAction type (future unification target, out of scope)
- `apps/tab-manager/src/lib/components/CommandPalette.svelte` — Quick actions consumer (future unification target, out of scope)
- `specs/20260311T172000-refactor-action-context.md` — Previous refactor that introduced the regex hack

## Review

**Completed**: 2026-03-12

### Summary

Added `title` and `destructive` fields to the action definition system across 7 files. The fields flow from `ActionConfig` through `ActionMeta`, `ActionDescriptor`, and into the tool bridge (`ToolDefinitionPayload`). All 13 tab-manager actions now have human-readable titles, and `tabs.close` is marked `destructive: true`. `ToolCallPart.svelte` uses a derived lookup map (`workspaceToolTitles`) to display titles, falling back to the regex-derived name for actions without titles.

### Deviations from Spec

- **4.1/4.2 approach**: Used the lookup map approach (spec option B from Open Question #2) since TanStack AI's `ToolCallPart` type doesn't carry arbitrary tool metadata. The map is derived from `iterateActions` at module scope, not from `workspaceTools`—this avoids any need to thread title through the TanStack AI client tool type.
- **Tool bridge `title` forwarding (2.3)**: Added `title` to `ToolDefinitionPayload` type for MCP wire format, but the actual forwarding from client tools to wire definitions is not implemented because the client tool type (`AnyClientTool`) doesn't support arbitrary properties. Title reaches MCP consumers via `describeWorkspace` → `ActionDescriptor.title` instead.

### Follow-up Work

- `requireApprovalForMutations` was identified as redundant with the `destructive` field and removed in the follow-up spec (`specs/20260312T170000-progressive-tool-trust.md`). The `needsApproval` flag is now set conditionally—only when `destructive: true`—rather than blanket-applied to all mutations.
- Unify `QuickAction` system with `.withActions()` metadata (out of scope per spec)
- Consider `category` field if path nesting proves insufficient for command palette grouping
- Consider `keywords` field if `title + description + path` search proves insufficient
