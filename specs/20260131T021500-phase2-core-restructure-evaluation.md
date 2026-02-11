# Phase 2: Core Directory Restructure Evaluation

**Status**: Planning document (do not execute)  
**Depends on**: Phase 1 completion  
**Decision needed**: After Phase 1, evaluate if restructuring is worth the effort

## Context

After Phase 1 fixes the immediate violations, we should evaluate whether the current `core/` directory structure is optimal or if restructuring would provide meaningful benefits.

This document outlines three options with trade-offs. **No decision has been made yet.**

---

## Current State (Post-Phase 1)

```
packages/epicenter/src/
├── core/
│   ├── actions.ts              # Action system (defineQuery, defineMutation)
│   ├── errors.ts               # ExtensionError types
│   ├── lifecycle.ts            # Lifecycle protocol
│   ├── types.ts                # AbsolutePath, ProjectDir
│   ├── schema/
│   │   ├── fields/             # Field types and factories
│   │   ├── converters/         # to-arktype, to-drizzle, to-typebox
│   │   ├── standard/           # Standard schema types
│   │   ├── schema-file.ts      # parseSchema utility
│   │   └── index.ts
│   └── utils/
│       └── y-keyvalue-lww.ts   # CRDT utility
├── dynamic/                    # Cell-level CRDT implementation
├── static/                     # Row-level versioned implementation
└── index.ts
```

**Observations**:

- `core/` contains two conceptually different things:
  1. Pure schema/type primitives (no runtime dependencies)
  2. CRDT utilities (Yjs-dependent)
- Both `static/` and `dynamic/` depend on `core/`
- The name "core" is vague; it could mean "core business logic" or "foundational primitives"

---

## Option A: Keep Current Structure (Recommended if Phase 1 suffices)

**Change**: None beyond Phase 1 fixes.

**Rationale**:

- Phase 1 fixes the actual bugs
- The current structure works; "core" is understood by the team
- Restructuring has cost (refactoring, updating imports, documentation)
- If it ain't broke after Phase 1, don't fix it

**When to choose this**:

- Phase 1 resolves all pain points
- No new developers are confused by the structure
- No planned features require clearer separation

---

## Option B: Rename and Split Core

**Change**: Restructure `core/` into more explicit directories.

**Proposed Structure**:

```
packages/epicenter/src/
├── schema/                     # Pure types (no Yjs)
│   ├── fields/
│   ├── converters/
│   ├── standard/
│   ├── workspace-definition.ts
│   └── index.ts
├── protocol/                   # Cross-cutting abstractions
│   ├── actions.ts
│   ├── lifecycle.ts
│   └── errors.ts
├── crdt/                       # Yjs utilities
│   └── y-keyvalue-lww.ts
├── dynamic/                    # Cell-level CRDT implementation
├── static/                     # Row-level versioned implementation
└── index.ts
```

**Benefits**:

- Clear separation: `schema/` has no runtime dependencies
- `crdt/` is explicitly Yjs-related
- `protocol/` groups cross-cutting concerns
- Easier to understand for new developers

**Costs**:

- Many import path changes
- Need to update `package.json` exports
- Documentation updates
- Risk of breaking external consumers

**Migration Path**:

1. Create new directories with re-exports from old locations
2. Update internal imports to new paths
3. Deprecate old paths with warnings
4. Remove old paths in next major version

**When to choose this**:

- Team frequently confused about what goes where
- Planning to expose more granular package exports
- Want clearer onboarding for new contributors

---

## Option C: Consolidate dynamic/table-helper.ts implementations

**Context**: There are two table-helper implementations in dynamic:

- `dynamic/table-helper.ts` — Y.Array based (older?)
- `dynamic/tables/table-helper.ts` — nested Y.Map based

**Change**: Investigate and potentially consolidate.

**Investigation Questions**:

1. Are both actively used?
2. Do they serve different purposes?
3. Can one be deprecated?

**Steps if consolidating**:

1. Audit all usages of each implementation
2. Document the differences
3. If one is legacy, mark it deprecated
4. Migrate usages to the preferred implementation
5. Remove deprecated code in next major version

**When to choose this**:

- The dual implementation causes confusion
- One is clearly legacy/unused
- Want to reduce maintenance burden

---

## Decision Framework

After Phase 1 is complete, answer these questions:

### Q1: Are there still pain points?

- If yes → Consider Option B or C
- If no → Stay with Option A

### Q2: Is the "core" naming causing confusion?

- If yes → Option B (rename to schema/protocol/crdt)
- If no → Option A

### Q3: Are the dual table-helper implementations problematic?

- If yes → Option C
- If no → Leave as-is

### Q4: Are we planning breaking changes anyway?

- If yes → Good time for Option B
- If no → Avoid restructuring

---

## Recommendation

**Start with Option A** (do nothing beyond Phase 1).

After 2-4 weeks of working with the cleaned-up codebase:

1. Reassess if restructuring is needed
2. If yes, prioritize Option C (consolidate table-helpers) over Option B (full restructure)
3. Only pursue Option B if there's a clear forcing function (new contributors, major version, etc.)

**The goal is a clean, working codebase—not a perfect architecture.** Phase 1 achieves the former. Phase 2 should only happen if there's evidence the current structure is actively causing problems.

---

## Appendix: Package Export Considerations

If pursuing Option B, the `package.json` exports would change:

**Current**:

```json
{
	".": "./src/index.ts",
	"./dynamic": "./src/dynamic/index.ts",
	"./static": "./src/static/index.ts"
}
```

**Potential (Option B)**:

```json
{
	".": "./src/index.ts",
	"./schema": "./src/schema/index.ts",
	"./protocol": "./src/protocol/index.ts",
	"./crdt": "./src/crdt/index.ts",
	"./dynamic": "./src/dynamic/index.ts",
	"./static": "./src/static/index.ts"
}
```

This is a breaking change for external consumers and should only be done in a major version bump.
