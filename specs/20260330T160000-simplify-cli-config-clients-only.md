# Simplify CLI Config: Accept Only WorkspaceClient Exports

**Date**: 2026-03-30
**Status**: Draft
**Author**: AI-assisted

## Overview

Remove `WorkspaceDefinition` support from the CLI config loader so `epicenter.config.ts` only accepts `createWorkspace()` results (clients). This eliminates the definition/client split, the auto-wiring branches in the daemon and data commands, and ~80 lines of branching logic.

## Motivation

### Current State

`loadConfig()` returns two arrays and every consumer branches on both:

```typescript
// load-config.ts
type LoadConfigResult = {
  configDir: string;
  definitions: AnyWorkspaceDefinition[];  // raw schemas: needs wiring
  clients: AnyWorkspaceClient[];          // pre-wired: passthrough
};
```

```typescript
// start-daemon.ts: branches to auto-wire definitions
const { definitions, clients } = await loadConfig(targetDir);
const allClients = [...clients];
for (const definition of definitions) {
  const client = createWorkspace(definition)
    .withExtension('persistence', filesystemPersistence(...))
    .withExtension('sync', createSyncExtension(...));
  allClients.push(client);
}
```

```typescript
// open-workspace.ts: branches again
const allEntries = [
  ...definitions.map(d => ({ type: 'definition', value: d })),
  ...clients.map(c => ({ type: 'client', value: c })),
];
// ...then branches on entry.type to wire persistence
```

This creates problems:

1. **Two code paths everywhere**: Every consumer of `loadConfig` branches on definition vs. client. The daemon wires persistence+sync; open-workspace wires persistence only. Each branch is subtly different.
2. **The daemon guesses what you want**: Auto-wiring `filesystemPersistence` + `createSyncExtension` for raw definitions means the daemon decides your extension stack. The config author has no control.
3. **Confusing for users**: "Do I export `defineWorkspace()` or `createWorkspace()`?" becomes a question with non-obvious consequences.

### Desired State

```typescript
// epicenter.config.ts: one pattern, always works
import { createTabManagerWorkspace } from './src/lib/workspace/workspace';

export const tabManager = createTabManagerWorkspace();
```

```typescript
// load-config.ts: one return type
type LoadConfigResult = {
  configDir: string;
  clients: AnyWorkspaceClient[];
};
```

```typescript
// start-daemon.ts: no branching
const { clients } = await loadConfig(targetDir);
await Promise.all(clients.map(c => c.whenReady));
```

Multiple workspaces via named exports:

```typescript
// epicenter.config.ts
export const tabManager = createTabManagerWorkspace();
export const whispering = createWhisperingWorkspace();
// CLI picks up both, validates unique IDs
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Drop `WorkspaceDefinition` support | Yes | Eliminates branching in 3 files, makes config self-contained |
| Keep named + default exports | Yes | `loadConfig` already handles both; no code change needed |
| Daemon no longer auto-wires extensions | Yes | Config author chains their own extensions. Explicit is better |
| Error message guides users | `createWorkspace({...})` | Clear migration path in error text |

## Architecture

### Before

```
epicenter.config.ts
        │
        ▼
  loadConfig()
  ┌─────────────────────────┐
  │ definitions[] + clients[]│
  └─────┬──────────┬────────┘
        │          │
  ┌─────▼────┐ ┌──▼──────────────┐
  │ raw def  │ │ pre-wired client│
  │ → wire   │ │ → passthrough   │
  │ persist  │ └─────────────────┘
  │ + sync   │
  └──────────┘
```

### After

```
epicenter.config.ts
        │
        ▼
  loadConfig()
  ┌─────────────┐
  │  clients[]  │
  └──────┬──────┘
         │
         ▼
    passthrough
```

## Implementation Plan

### Phase 1: Simplify load-config.ts

- [ ] **1.1** Remove `AnyWorkspaceDefinition` type alias
- [ ] **1.2** Remove `definitions` from `LoadConfigResult`: just `clients: AnyWorkspaceClient[]`
- [ ] **1.3** Remove `isWorkspaceDefinition()` helper
- [ ] **1.4** Remove `classifyAndAdd()` helper: replace with direct `isWorkspaceClient()` check + push
- [ ] **1.5** Update error message to say `export default createWorkspace({...})`
- [ ] **1.6** `loadClientFromPath()`: already client-only, just clean up error messages if needed

### Phase 2: Simplify start-daemon.ts

- [ ] **2.1** Remove the `for (const definition of definitions)` wiring loop (lines 66-92)
- [ ] **2.2** `const allClients = clients`: no spread, no loop
- [ ] **2.3** Remove unused imports: `createWorkspace`, `filesystemPersistence`, `createSyncExtension`

### Phase 3: Simplify open-workspace.ts

- [ ] **3.1** Remove `allEntries` type-tagging pattern: work directly with `clients[]`
- [ ] **3.2** Remove the `entry.type === 'definition'` branch and manual persistence wiring
- [ ] **3.3** Remove unused imports: `createWorkspace`, `filesystemPersistence`

### Phase 4: Update honeycrisp fixture + tests

- [ ] **4.1** Change `honeycrisp-basic/epicenter.config.ts` from `defineWorkspace(...)` to `createWorkspace(defineWorkspace(...))`
- [ ] **4.2** Update `e2e-honeycrisp.test.ts`: tests currently do `loadConfig()` → `definitions[0]` → manual `createWorkspace(definition)`. Change to `loadConfig()` → `clients[0]` since the config now exports a client
- [ ] **4.3** Run tests: `bun test` in `packages/cli`

### Phase 5: Verify

- [ ] **5.1** `bun run typecheck` passes
- [ ] **5.2** `bun test` passes in `packages/cli`
- [ ] **5.3** Grep for any remaining `definitions` references in CLI package

## Edge Cases

### Config exports a raw `defineWorkspace()` (no `createWorkspace`)

1. User has old-style config: `export default defineWorkspace({...})`
2. `isWorkspaceClient()` returns false (no `definitions` or `tables` properties)
3. Export is skipped → "No workspace clients found" error with clear guidance

### Config exports a function instead of a client

1. `createTabManagerWorkspace` exported without calling it (no `()`)
2. `typeof value !== 'object'` check filters it out
3. Error message guides: "Expected: `export default createWorkspace({...})`"

### Mixed exports (some definitions, some clients)

After this change, definitions are silently ignored. Only clients are collected. The error message covers the case where zero clients are found.

## Open Questions

1. **Should `WorkspaceDefinition` type still be exported from `@epicenter/workspace`?**
   - Yes: `defineWorkspace()` is still useful for schema declaration. We're only removing CLI support for raw definitions, not the type itself.
   - **Recommendation**: No changes to `@epicenter/workspace` exports.

## Success Criteria

- [ ] `loadConfig()` returns `{ configDir, clients }`: no `definitions` field
- [ ] `start-daemon.ts` has zero branching between definitions and clients
- [ ] `open-workspace.ts` has zero branching between definitions and clients
- [ ] Honeycrisp fixture exports a `createWorkspace()` result
- [ ] All CLI tests pass
- [ ] Typecheck passes

## References

- `packages/cli/src/config/load-config.ts`: main loader (simplify)
- `packages/cli/src/config/resolve-config.ts`: already client-only via `loadClientFromPath`
- `packages/cli/src/runtime/start-daemon.ts`: daemon wiring (simplify)
- `packages/cli/src/runtime/open-workspace.ts`: data command wiring (simplify)
- `packages/cli/test/fixtures/honeycrisp-basic/epicenter.config.ts`: fixture (update)
- `packages/cli/test/e2e-honeycrisp.test.ts`: tests (update)
- `apps/tab-manager/src/lib/workspace/workspace.ts`: factory pattern to follow
