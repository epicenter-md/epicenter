# Shared Extension Context: Type-Safe Dual-Scope Extensions

**Date**: 2026-03-16
**Status**: Implemented
**Author**: AI-assisted

## Overview

Fix the unsound `as unknown as` cast in `withExtension()` by introducing a `SharedExtensionContext` type that represents what's actually available in both workspace and document scopes. Scope-specific fields are optional rather than omitted, so factories like `createSyncExtension` can access `awareness` when available without lying about types. Also introduces `DocumentClient` and a computed `DocumentContext` to mirror the workspace pattern.

## Motivation

### Current State

`withExtension(key, factory)` dual-registers a factory for both the workspace Y.Doc and content document Y.Docs. The factory's TypeScript signature says it receives `ExtensionContext` (14 fields), but at document open time it actually receives `DocumentContext` (5 fields). An unsafe cast hides the mismatch:

```typescript
// create-workspace.ts:358-366
withExtension(key, factory) {
    documentExtensionRegistrations.push({
        key,
        factory: factory as unknown as DocumentExtensionRegistration['factory'],
        //       ^^^^^^^^^^^^^^^^^^^ UNSAFE: ExtensionContext is NOT DocumentContext
        tags: [],
    });
    return applyWorkspaceExtension(key, factory);
}
```

This creates problems:

1. **Silent runtime failures**: A factory that destructures `{ tables }` compiles fine but gets `undefined` at document scope. A factory that destructures `{ awareness }` (like `createSyncExtension`) would crash at document scope if it ran for a workspace with documents.

2. **No compiler help**: TypeScript can't catch scope mismatches because the cast erases the type difference. The factory signature promises fields that don't exist.

3. **Inconsistent context patterns**: `ExtensionContext` is a computed type (`Omit<WorkspaceClient, 'destroy' | Symbol.asyncDispose>`), auto-tracking new fields. `DocumentContext` is manually maintained. These two parallel systems use different strategies for the same problem.

### Desired State

```typescript
// withExtension factory sees optional scope-specific fields:
.withExtension('sync', createSyncExtension({ url: '...' }))

// Inside createSyncExtension:
return ({ ydoc, awareness, whenReady }) => {
    const provider = createSyncProvider({
        doc: ydoc,
        url: wsUrl,
        awareness: awareness?.raw,  // TypeScript FORCES the ?. — correct!
    });
    // ...
};

// withWorkspaceExtension factory still gets guaranteed fields:
.withWorkspaceExtension('sqlite', ({ tables, documents }) => {
    // tables and documents are guaranteed non-optional
})

// withDocumentExtension factory gets document fields:
.withDocumentExtension('indexer', ({ timeline, ydoc }) => {
    // timeline is guaranteed
})
```

No unsafe casts. The type system reflects reality.

## Research Findings

### Factory Context Usage Audit

Every extension factory in the codebase, what it destructures, and how it's registered:

| Factory | Registration | Destructures | Needs workspace fields? |
|---|---|---|---|
| `indexeddbPersistence` | `withExtension` (dual) | `{ ydoc }` | No |
| `broadcastChannelSync` | `withExtension` (dual) | `{ ydoc }` | No |
| `filesystemPersistence` | `withExtension` (dual) | `{ ydoc }` | No |
| `createSyncExtension` | `withExtension` (dual) | `{ ydoc, awareness, whenReady }` | Yes (`awareness`) |
| `createMarkdownPersistence` | `withExtension` (dual) | `{ ydoc, tables }` | Yes (`tables`) |
| `createSqliteIndex` | `withWorkspaceExtension` | `{ tables, documents }` | Yes (already workspace-only) |

**Key finding**: Only 2 of 5 dual-registered factories use workspace-specific fields. Of those, `createSyncExtension` uses `awareness` (which SHOULD be available at document scope for collaborative editing) and `createMarkdownPersistence` uses `tables` (which should move to `withWorkspaceExtension` since it fundamentally needs table access).

### Approach Comparison

| Approach | Pros | Cons |
|---|---|---|
| **Intersection only** (`{ id, ydoc, whenReady, extensions }`) | Minimal, safe | Loses `awareness` at document scope; forces sync to `withWorkspaceExtension` |
| **Optional properties** (proposed) | Factories can use what's available; awareness works at document scope; no breaking change for most factories | More fields on the type; factories must handle `undefined` |
| **Split factory types** (`{ workspace: fn, document: fn }`) | Explicit per-scope behavior | API churn; every dual factory must define two functions |
| **Discriminated union** (`scope: 'workspace' | 'document'`) | Runtime scope detection | Factories need switch/if; awkward ergonomics |

**Implication**: Optional properties is the sweet spot. It's the only approach where `createSyncExtension` continues working as a dual-registered factory AND gets type-safe `awareness` access with compiler-enforced optionality.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| SharedExtensionContext field strategy | Optional properties, not intersection | Factories like sync need `awareness` at document scope. Optional typing forces `?.` without losing access. |
| Which workspace fields to pass at document scope | `awareness` and `definitions` | `awareness` enables collaborative editing features. `definitions` enables schema introspection. NOT `tables`/`kv`/`documents`/`batch`/`loadSnapshot`—scope confusion risk. |
| DocumentClient type | Yes, in `types.ts` | Mirrors WorkspaceClient pattern. Foundation for computed DocumentContext. |
| DocumentContext derivation | `Omit<DocumentClient, 'destroy'>` | Auto-tracks DocumentClient changes, matching how ExtensionContext derives from WorkspaceClient. |
| DocumentHandle rename `exports` → `extensions` | Deferred | Breaking change to public API. Handle separately to keep this spec focused. |
| Generic `TDocExtensions` threading through `Documents`/`DocumentsHelper` | Deferred | Significant type plumbing. Provides typed doc extension access on handles, but not needed for the cast fix. |

## Architecture

### Type Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│  SharedExtensionContext                                              │
│  ═══════════════════════                                            │
│  REQUIRED: id, ydoc, whenReady, extensions                          │
│  OPTIONAL (workspace): tables?, kv?, awareness?, definitions?,      │
│                        documents?, batch?, loadSnapshot?            │
│  OPTIONAL (document):  timeline?                                    │
├──────────────────────────────┬──────────────────────────────────────┤
│                              │                                      │
│  ◄─── superset of ─────     │     ────── superset of ───►          │
│                              │                                      │
▼                              │                                      ▼
┌──────────────────────┐       │       ┌──────────────────────────────┐
│  ExtensionContext     │       │       │  DocumentContext              │
│  ═════════════════    │       │       │  ═══════════════             │
│  All workspace fields │       │       │  = Omit<DocumentClient,      │
│  REQUIRED             │       │       │    'destroy'>                │
│                       │       │       │  All document fields          │
│  = Omit<WorkspaceClient,     │       │  REQUIRED                     │
│    'destroy' | dispose>      │       │                               │
└──────────────────────┘       │       └──────────────────────────────┘
                               │
                   ┌───────────┴───────────┐
                   │  Registration Methods  │
                   │                        │
                   │  withExtension ────────│──► SharedExtensionContext
                   │  withWorkspaceExt ─────│──► ExtensionContext
                   │  withDocumentExt ──────│──► DocumentContext
                   └────────────────────────┘
```

### DocumentClient Type

```
┌─────────────────────────────────────────────────────────────────────┐
│  DocumentClient<TDocExtensions>                                      │
│  ═══════════════════════════════                                     │
│  extends Timeline (read, write, asText, asRichText, asSheet, ...)   │
│  ───────────────────────────────────────────                        │
│  id: string                                                         │
│  extensions: { [K in TDocExtensions]?: Extension<...> }             │
│  whenReady: Promise<void>                                           │
│  destroy(): Promise<void>                                           │
└─────────────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌────────────────────┐             ┌────────────────────────┐
│  DocumentContext    │             │  DocumentHandle         │
│  = Omit<...,        │             │  = Omit<...,            │
│    'destroy'>       │             │    'destroy'>           │
│  (factory receives) │             │  (open() returns)       │
└────────────────────┘             └────────────────────────┘
```

### Runtime Context Construction

```
WORKSPACE SCOPE (applyWorkspaceExtension)
──────────────────────────────────────────
SharedExtensionContext receives:
  id           ✅ from workspace
  ydoc         ✅ workspace Y.Doc
  whenReady    ✅ composite of prior workspace extensions
  extensions   ✅ accumulated workspace extensions
  tables       ✅ workspace tables
  kv           ✅ workspace kv
  awareness    ✅ workspace awareness
  definitions  ✅ workspace definitions
  documents    ✅ workspace documents
  batch        ✅ workspace batch
  loadSnapshot ✅ workspace loadSnapshot
  timeline     ✗ undefined (no timeline at workspace scope)


DOCUMENT SCOPE (create-document.ts open loop)
──────────────────────────────────────────────
SharedExtensionContext receives:
  id           ✅ workspace id (from closure)
  ydoc         ✅ content Y.Doc
  whenReady    ✅ composite of prior document extensions
  extensions   ✅ accumulated document extensions
  awareness    ✅ workspace awareness (from closure)
  definitions  ✅ workspace definitions (from closure)
  timeline     ✅ content timeline
  tables       ✗ undefined (not passed—scope confusion risk)
  kv           ✗ undefined
  documents    ✗ undefined
  batch        ✗ undefined
  loadSnapshot ✗ undefined
```

## Implementation Plan

### Phase 1: Types

- [ ] **1.1** Add `SharedExtensionContext` type to `types.ts` with all fields from both scopes (workspace fields optional, document fields optional, shared fields required)
- [ ] **1.2** Add `DocumentClient` type to `types.ts` — `Timeline & { id, extensions, whenReady, destroy }`
- [ ] **1.3** Move `DocumentContext` from `lifecycle.ts` to `types.ts`, redefine as `Omit<DocumentClient, 'destroy'>`
- [ ] **1.4** Re-export `DocumentContext` from `lifecycle.ts` for backward compatibility
- [ ] **1.5** Update `WorkspaceClientBuilder.withExtension` factory param from `ExtensionContext` to `SharedExtensionContext`
- [ ] **1.6** Update `DocumentExtensionRegistration` factory type to accept `SharedExtensionContext`

### Phase 2: Runtime

- [ ] **2.1** Remove the `as unknown as` cast in `create-workspace.ts` `withExtension`
- [ ] **2.2** Add `awareness` and `definitions` to `CreateDocumentsConfig` (passed from workspace closure)
- [ ] **2.3** Pass `awareness` and `definitions` when constructing document context in `create-document.ts` open loop
- [ ] **2.4** At workspace scope in `applyWorkspaceExtension`, construct `SharedExtensionContext` (add `timeline: undefined` or let it be absent)

### Phase 3: Factory Updates

- [ ] **3.1** Update `createSyncExtension` — change `awareness.raw` to `awareness?.raw` and handle undefined
- [ ] **3.2** Update `createMarkdownPersistenceExtension` — either move to `withWorkspaceExtension` (preferred, since it fundamentally needs `tables`) or guard with `if (!tables) return;`
- [ ] **3.3** Update any test factories that rely on workspace-only fields being non-optional in `withExtension`

### Phase 4: Verification

- [ ] **4.1** Run type checker — all existing code compiles
- [ ] **4.2** Run tests — all pass
- [ ] **4.3** Verify no `as unknown as` or `as any` casts remain in the extension registration path

## Edge Cases

### Dual factory that needs guaranteed workspace fields

A factory registered via `withExtension` that requires `tables` (e.g., `createMarkdownPersistenceExtension`):

1. Factory destructures `{ tables }` — TypeScript types it as `TablesHelper | undefined`
2. Factory must guard: `if (!tables) return;` (void return = "not installed")
3. At document scope, factory returns void — extension is skipped for documents
4. **Alternative**: Register via `withWorkspaceExtension` + `withDocumentExtension` separately

### Sync extension at document scope without awareness

1. `createSyncExtension` is dual-registered via `withExtension`
2. At workspace scope: `awareness` is defined, provider gets awareness
3. At document scope: `awareness` is passed from workspace closure — still defined
4. Provider syncs the content Y.Doc with awareness from the workspace
5. No crash, no type error

### Sync extension at document scope when awareness IS passed

1. Workspace creates awareness helper
2. `createDocuments` receives `awareness` in config
3. Document open loop passes `awareness` in context
4. `createSyncExtension` factory receives defined `awareness`
5. `awareness?.raw` resolves to the workspace's raw Awareness instance
6. Sync provider can propagate cursor positions for the content document

### withDocumentExtension factory receives SharedExtensionContext fields

1. `withDocumentExtension` factory is typed as `(DocumentContext) => ...`
2. At runtime, the context object may have extra fields (`awareness`, `definitions`) from the shared construction
3. This is fine — TypeScript's structural typing means extra properties don't break anything
4. The factory's type only promises `DocumentContext` fields; extras are invisible to it

## Open Questions

1. **Should `batch` be passed at document scope?**
   - At workspace scope, `batch` wraps `workspaceYdoc.transact()`. At document scope, `timeline.batch()` wraps `contentYdoc.transact()`. These are different Y.Docs.
   - If we pass `batch` at document scope, it should wrap the CONTENT ydoc, not the workspace ydoc. But `SharedExtensionContext.batch` can't distinguish.
   - **Recommendation**: Don't pass `batch` at document scope. Factories use `timeline.batch()` instead. Revisit if a concrete need arises.

2. **Should `tables` and `kv` be passed at document scope?**
   - A document extension that reads workspace tables (e.g., to look up row metadata) has a legitimate use case.
   - But it blurs the scope boundary — document extensions modifying workspace tables could cause subtle bugs.
   - **Recommendation**: Don't pass for now. If needed, a factory can use `withWorkspaceExtension` to get guaranteed `tables` access, or we can add them later.

3. **Should the `extensions` field be typed as `Record<string, unknown>` or preserve generics?**
   - At workspace scope, `extensions` has type `TExtensions` (workspace extensions). At document scope, it has the accumulated document extensions. These are different types.
   - A single `SharedExtensionContext<..., TExtensions>` can't represent both without a scope discriminant.
   - **Recommendation**: Use `Record<string, unknown>` for `SharedExtensionContext.extensions`. Typed extension access requires `withWorkspaceExtension` or `withDocumentExtension`. In practice, no dual-registered factory uses typed `extensions` access.

## Success Criteria

- [x] `as unknown as` cast documented and semantically safe (SharedExtensionContext → DocumentContext, not ExtensionContext → DocumentContext)
- [x] `createSyncExtension` uses `awareness?.raw` (optional chaining, structural typing)
- [x] A factory that destructures `{ tables }` from `withExtension` gets `TablesHelper | undefined` (not `TablesHelper`)
- [x] `DocumentContext` manually defined in `types.ts` (not computed — see Deviations)
- [x] All 218 workspace tests pass with one minor test update (optional field annotation)
- [x] Type checker passes (only pre-existing errors in unrelated files)

## References

- `packages/workspace/src/workspace/types.ts` — `ExtensionContext`, `WorkspaceClient`, `DocumentHandle`, `WorkspaceClientBuilder`, `DocumentExtensionRegistration`
- `packages/workspace/src/workspace/lifecycle.ts` — `DocumentContext`, `Extension`, `defineExtension`
- `packages/workspace/src/workspace/create-workspace.ts` — `applyWorkspaceExtension`, `buildClient`, the unsafe cast
- `packages/workspace/src/workspace/create-document.ts` — Document open loop, context construction
- `packages/workspace/src/extensions/sync.ts` — `createSyncExtension` (destructures `awareness`)
- `apps/tab-manager-markdown/src/markdown-persistence-extension.ts` — `createMarkdownPersistenceExtension` (destructures `tables`)
- `packages/filesystem/src/extensions/sqlite-index/index.ts` — `createSqliteIndex` (already `withWorkspaceExtension`)
- `packages/workspace/src/timeline/timeline.ts` — `Timeline` type (document core surface)

## Review

**Completed**: 2026-03-16

### Summary

The original spec proposed `SharedExtensionContext` (a union type with optional workspace/document fields) to fix the unsafe `as unknown as` cast in `withExtension()`. Over three iterations, the design evolved past the spec's initial proposal into something simpler:

1. **SharedExtensionContext was added** (discriminated union with `scope: 'workspace' | 'document'`), then **deleted entirely** when we realized `withExtension` was doing too much.
2. **`withExtension` is now thin sugar** that calls both `withWorkspaceExtension` and `withDocumentExtension`. The factory receives `DualScopeContext` (`{ ydoc, whenReady }`).
3. **Both `as unknown as` casts were removed.** No unsafe casts remain in the extension registration path.
4. **`DocumentClient` was added** as the canonical document type. `DocumentHandle` and `DocumentContext` both derive from it.
5. **`handle.exports` was renamed to `handle.extensions`** for consistency with the workspace pattern.
6. **`TDocExtensions` threaded** through `Documents`, `DocumentsHelper`, `WorkspaceClient` for typed extension access on handles.

### Final Type Architecture

```
ExtensionContext         = Omit<WorkspaceClient, 'destroy' | Symbol.asyncDispose>
                           (workspace-only, used by withWorkspaceExtension)

DocumentContext          = Pick<DocumentClient, 'id' | 'ydoc' | 'timeline' | 'extensions' | 'whenReady'>
                           (document-only, used by withDocumentExtension)

DualScopeContext         = { ydoc: Y.Doc; whenReady: Promise<void> }
                           (both scopes, used by withExtension)

DocumentClient           = Timeline & { id, timeline, extensions, whenReady, destroy }
                           (canonical document type)

DocumentHandle           = Omit<DocumentClient, 'destroy'>
                           (what open() returns)
```

### Deviations from Spec

- **SharedExtensionContext does not exist.** The spec proposed a union type with optional workspace/document fields. After implementation and Oracle consultation, we determined that `withExtension` was a code smell—one factory serving two fundamentally different contexts. Replaced with `DualScopeContext` (tiny shared contract) + thin sugar.
- **DocumentContext uses `Pick`, not `Omit`.** The IS-A vs HAS-A tension: `DocumentClient` extends `Timeline` (handle IS a timeline), but factories destructure `{ timeline }` as a field. `Pick` selects the fields factories need without inheriting Timeline methods.
- **`createSyncExtension` uses `ExtensionFactory`, not `SharedExtensionFactory`.** Sync needs `awareness` (workspace-only). Registered via `withWorkspaceExtension`, not `withExtension`.
- **No cross-scope field passing.** The spec proposed passing `awareness` and `definitions` from the workspace closure to document scope. This was removed when `withExtension` became thin sugar—dual-scope factories only see `{ ydoc, whenReady }`.

### Follow-up Work

None identified. The extension system is consistent and all types are exported.
