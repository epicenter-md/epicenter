# Standardize Persistence Location

**Date**: 2026-04-15
**Status**: Partially superseded: 2026-04-18
**Author**: AI-assisted

> **2026-04-18 Update**: `connectWorkspace` no longer uses persistence at all: the "global is correct" row below no longer applies to scripts. `EPICENTER_PATHS.persistence()` remains the standard location for daemon configs (`epicenter.config.ts`). The guidance for playground/daemon configs in this spec is unchanged.
>
> **Path note (2026-05-22):** The remaining `~/.epicenter/persistence/` guidance is superseded. Do not copy this spec's global persistence location into new work. Runtime persistence should use the current path owners described in `20260522T203209-top-level-epicenter-path-cleanup.md`; project-local generated data remains valid under `<projectDir>/.epicenter/`.

## Overview

Extract path resolution into a single source of truth (`packages/cli/src/home.ts`) and standardize all persistence to the global home directory (`~/.epicenter/persistence/`). Materialization stays project-local. Auth is already global.

## Motivation

### Current State

Three persistence conventions coexist:

```typescript
// connectWorkspace: global (correct)
filePath: join(resolveEpicenterHome(), 'persistence', `${base.id}.db`)

// Playground configs: project-local (inconsistent)
const PERSISTENCE_DIR = join(import.meta.dir, '.epicenter', 'persistence');
filePath: join(PERSISTENCE_DIR, 'opensidian.db')

// Vault config: no persistence at all (bug)
// just materializer → unlock → sync
```

This creates problems:

1. **No single convention**: Config authors must guess whether persistence goes in the project or the home directory.
2. **Vault config bug**: No persistence means every `epicenter start` re-downloads the full workspace from the server instead of exchanging a delta.
3. **No path helper**: Persistence paths are constructed ad-hoc with `join()` calls that repeat the `persistence/<id>.db` convention.

### Desired State

```
~/.epicenter/                          ← GLOBAL HOME
├── auth/sessions.json                 ← Auth (already correct)
└── persistence/
    ├── epicenter.fuji.db              ← All persistence here
    ├── epicenter.tab-manager.db
    └── epicenter.opensidian.db

~/Code/vault/                          ← PROJECT (epicenter.config.ts)
├── fuji/*.md                          ← Materialization: project-local
├── tab-manager/*.md
└── (no .epicenter/ folder)            ← Persistence moved to global home
```

Config authors use one helper:

```typescript
import { resolvePersistencePath } from '@epicenter/cli';

filesystemPersistence({ filePath: resolvePersistencePath('epicenter.opensidian') })
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Path utility location | `packages/cli/src/home.ts` | CLI already owns `resolveEpicenterHome`. Browser apps use IndexedDB (no file paths). Keep file-path logic in the CLI package. |
| Extract vs inline | Extract `resolveEpicenterHome` to `home.ts` | Currently buried in `cli.ts` alongside the CLI runner. Standalone module is importable by `connect.ts`, configs, and tests. |
| Persistence convention | Always `~/.epicenter/persistence/<workspace-id>.db` | Persistence is a cache (deletable, rebuilds from sync). Global location means any consumer of the same workspace ID shares the cache. |
| Materialization convention | Always project-local (`import.meta.dir`) | Materialized files are the human-readable output. Users want them next to their config. |
| Helper API | `resolvePersistencePath(workspaceId, home?)` | Single function. Takes workspace ID, optional home override. Returns the full file path. |

## Implementation Plan

### Phase 1: Extract path utilities

- [ ] **1.1** Create `packages/cli/src/home.ts` with `resolveEpicenterHome` (moved from `cli.ts`) and `resolvePersistencePath` (new)
- [ ] **1.2** Update `packages/cli/src/cli.ts` to import `resolveEpicenterHome` from `./home.js`
- [ ] **1.3** Update `packages/cli/src/connect.ts` to import from `./home.js` and use `resolvePersistencePath`
- [ ] **1.4** Update `packages/cli/src/index.ts` to re-export `resolvePersistencePath` from `./home`

### Phase 2: Fix configs

- [ ] **2.1** Update `playground/opensidian-e2e/epicenter.config.ts` to use global persistence via `resolvePersistencePath`
- [ ] **2.2** Update `playground/tab-manager-e2e/epicenter.config.ts` to use global persistence via `resolvePersistencePath`

### Phase 3: Verify

- [ ] **3.1** Run typecheck: zero new errors
- [ ] **3.2** Verify LSP diagnostics clean on all changed files

## Success Criteria

- [ ] `resolveEpicenterHome` lives in `home.ts`, imported by `cli.ts` and `connect.ts`
- [ ] `resolvePersistencePath` is exported from `@epicenter/cli`
- [ ] Both playground configs use `~/.epicenter/persistence/` (no more project-local `.epicenter/`)
- [ ] Typecheck passes with no new errors
- [ ] `connectWorkspace` uses `resolvePersistencePath`

## References

- `packages/cli/src/cli.ts`: current home of `resolveEpicenterHome`
- `packages/cli/src/connect.ts`: uses ad-hoc persistence path
- `packages/cli/src/auth/store.ts`: pattern reference (takes `home` param, builds path internally)
- `playground/opensidian-e2e/epicenter.config.ts`: project-local persistence (to fix)
- `playground/tab-manager-e2e/epicenter.config.ts`: project-local persistence (to fix)
