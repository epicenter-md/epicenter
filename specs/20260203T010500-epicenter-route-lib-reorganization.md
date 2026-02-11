# Epicenter Route & `lib/` Reorganization (Workspaces)

## Context

Epicenter’s SvelteKit app currently has workspace-related code spread across:

- Deep route nesting under `routes/(workspace)/workspaces/...`
- A `src/lib/` layout that mixes concerns (`lib/docs/` contains Yjs/workspace utilities)
- Static workspace viewer components located inside route `_components/` while other UI lives in `lib/components/`

This spec proposes a refactor to improve:
- Discoverability (where code “lives”)
- Consistency (component placement)
- Maintainability (co-locate workspace logic)

This spec intentionally does *not* cover the static workspace storage/manifest format (split into a separate spec).

## Goals

- Make it obvious where “workspace” code lives (dynamic + static).
- Move route-private `_components/` that are actually reusable into `src/lib/`.
- Rename misleading folders (e.g. `lib/docs/` → `lib/yjs/` or `lib/workspaces/`).
- Keep behavioral changes minimal; prefer mechanical moves + import updates first.

## Non-goals

- Change user-facing URLs unless there’s a clear payoff and a migration plan.
- Introduce a unified dynamic/static workspace abstraction (can be a follow-up spec).

---

## Structure (after reorganization)

```
apps/epicenter/src/
├── routes/(workspace)/workspaces/[id]/...
├── routes/(workspace)/workspaces/static/[id]/...
└── lib/
    ├── components/*
    ├── query/
    │   ├── client.ts
    │   └── index.ts         # re-exports from workspaces/*/queries
    ├── workspaces/
    │   ├── dynamic/
    │   │   ├── index.ts
    │   │   ├── queries.ts
    │   │   └── service.ts
    │   └── static/
    │       ├── components/
    │       │   ├── index.ts
    │       │   ├── GenericTableViewer.svelte
    │       │   ├── GenericKvViewer.svelte
    │       │   └── StaticWorkspaceSidebar.svelte
    │       ├── index.ts
    │       ├── queries.ts
    │       ├── service.ts
    │       └── types.ts
    └── yjs/                 # renamed from lib/docs/
        ├── README.md
        ├── workspace.ts
        ├── workspace-persistence.ts
        ├── y-sweet-connection.ts
        └── discover.ts
```

## Proposed Organization Options

### Option A: Feature-Based (recommended)

Co-locate everything by domain:

```
apps/epicenter/src/lib/
├── components/                 # truly shared UI primitives
└── workspaces/
    ├── dynamic/
    ├── static/
    └── shared/
```

Pros:
- Clear ownership and navigation
- Easier to refactor and extend (new workspace types get new folders)

Cons:
- Larger initial move (many imports)

### Option B: Layer-Based (minimal change)

Keep `services/`, `query/`, `components/` but improve naming and grouping:
- `lib/docs/` → `lib/yjs/`
- `components/workspace/{dynamic,static}` for workspace UI

Pros:
- Less churn

Cons:
- Still “scattered” when working on a feature end-to-end

### Option C: Unified Workspace Abstraction (follow-up)

Unify dynamic/static behavior under one `Workspace` type and route surface.

This is a larger architectural/product decision and is best handled as its own spec once the code is reorganized.

---

## Route Reorganization Notes

SvelteKit route groups like `(workspace)` do not impact the URL. If the problem is “filesystem depth” rather than “URL verbosity”, it’s fine to keep the group and focus on `lib/` organization first.

If we do want to change URLs/route patterns:
- Decide whether static workspaces should live at `workspaces/static/[id]` (explicit) or a single `workspaces/[id]` with disambiguation rules.
- Provide redirects/migrations where possible.

Recommendation: **defer URL changes** until after `lib/` reorg is complete.

---

## Recommended Plan (Option A, staged)

### Phase 1: Component Moves (no behavior change) ✅

- ✅ Moved static workspace viewer components from route `_components/` into:
  - `apps/epicenter/src/lib/workspaces/static/components/`
  - `GenericTableViewer.svelte`, `GenericKvViewer.svelte`, `StaticWorkspaceSidebar.svelte`
  - Created barrel export `index.ts`
- ⏭️ `WorkspaceSidebar.svelte` already in `$lib/components/` (no move needed)
- ✅ Updated imports in `+page.svelte` and `+layout.svelte`

### Phase 2: Rename misleading folders ✅

- ✅ Renamed `apps/epicenter/src/lib/docs/` to `apps/epicenter/src/lib/yjs/`
- ✅ Updated all imports across the codebase
- ✅ Updated README.md with new import paths

### Phase 3: Consolidate query/services/types under workspace feature folders ✅

**Static workspaces:**
- ✅ `lib/query/static-workspaces.ts` → `lib/workspaces/static/queries.ts`
- ✅ `lib/services/static-workspaces.ts` → `lib/workspaces/static/service.ts`
- ✅ `lib/static-workspaces/types.ts` → `lib/workspaces/static/types.ts`
- ✅ Created barrel export `lib/workspaces/static/index.ts`

**Dynamic workspaces:**
- ✅ `lib/query/workspaces.ts` → `lib/workspaces/dynamic/queries.ts`
- ✅ `lib/services/workspaces.ts` → `lib/workspaces/dynamic/service.ts`
- ✅ Created barrel export `lib/workspaces/dynamic/index.ts`
- ✅ Updated `lib/query/index.ts` to re-export from new locations

### Phase 4 (optional): Route flattening

Deferred. Only if there's clear benefit, consider flattening route filesystem depth or reducing duplicated layouts between static/dynamic workspace pages.

---

## Open Questions

1. Which route stability constraints do we have (deep links, bookmarks, external links)?
2. Should workspace UI components live under `lib/workspaces/**/components` or under `lib/components/workspaces/**`?
3. Should we introduce a shared `Sidebar` primitive in `lib/components/sidebar/` and keep workspace-specific sidebars feature-local?

