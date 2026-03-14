# DO Naming Convention: Include Type Segment

**Status:** Completed (merged in PR #1520)
**Scope:** 2 files, ~10 line changes
**Worktree:** Separate branch off `main` (not this branch)

## Problem

DO names are `user:{userId}:{resourceName}` for both workspace and document routes. Since `WORKSPACE_ROOM` and `DOCUMENT_ROOM` are separate CF namespaces, `idFromName()` produces different DO instances—but the name strings are identical. This causes a bug in the `durable_object_instance` tracking table (see sibling spec) where a UNIQUE constraint on `doName` collides when a user has a workspace and document with the same `resourceName`.

More fundamentally, the current naming scheme doesn't encode **what kind of DO** it is. Given the string `user:abc:notes`, you can't tell if it's a workspace or a document without additional context.

## Decision

**All DO names include the type segment: `user:{userId}:{doType}:{resourceName}`.**

| Route | Old DO Name | New DO Name |
|---|---|---|
| `GET /workspaces/epicenter.tab-manager` | `user:abc:epicenter.tab-manager` | `user:abc:workspace:epicenter.tab-manager` |
| `GET /documents/my-note` | `user:abc:my-note` | `user:abc:document:my-note` |

### Why this matters

1. **Self-documenting**—the DO name tells you exactly what it is
2. **Globally unique across namespaces**—no collisions in tracking tables
3. **Reverse-lookup friendly**—given a DO name from logs/analytics, you can parse out type + resource
4. **Future-proof**—if a third DO type is added, the pattern scales

### Migration strategy

**Clean break.** Same approach as the `tab-manager` → `epicenter.tab-manager` rename. Local-first clients hold the full Y.Doc and will re-sync to the new (empty) DO on next connection. Old DOs sit idle and can be cleaned up later.

**Document snapshots will be lost** for `DocumentRoom` DOs (stored in the old DO's SQLite). This is acceptable during early development—no production users have critical snapshot history yet.

## Implementation Plan

### Task 1: Update stub functions in `app.ts`

- [x] Change `getWorkspaceStub` DO name: `user:${userId}:${workspace}` → `user:${userId}:workspace:${workspace}`
- [x] Change `getDocumentStub` DO name: `user:${userId}:${document}` → `user:${userId}:document:${document}`

**`getWorkspaceStub` (app.ts:294–297):**

```typescript
function getWorkspaceStub(c: Context<Env>) {
	const doName = `user:${c.var.user.id}:workspace:${c.req.param('workspace')}`;
	return c.env.WORKSPACE_ROOM.get(c.env.WORKSPACE_ROOM.idFromName(doName));
}
```

**`getDocumentStub` (app.ts:300–303):**

```typescript
function getDocumentStub(c: Context<Env>) {
	const doName = `user:${c.var.user.id}:document:${c.req.param('document')}`;
	return c.env.DOCUMENT_ROOM.get(c.env.DOCUMENT_ROOM.idFromName(doName));
}
```

### Task 2: Update JSDoc comments

- [x] Update the DO name namespacing JSDoc block above `getWorkspaceStub` (app.ts:265–291)
- [x] Update JSDoc in `base-sync-room.ts` (line 90–93) that references the naming scheme

**JSDoc update in app.ts (first line of the block, line 266):**

```
- * DO name namespacing: `user:{userId}:{workspace|document}`
+ * DO name namespacing: `user:{userId}:{type}:{name}`
```

**JSDoc update in base-sync-room.ts (lines 90–93):**

```
- * DO names are user-scoped: the Worker prefixes `user:{userId}:` to the
- * client-provided workspace or document name before calling `idFromName()`.
+ * DO names are user-scoped: the Worker constructs
+ * `user:{userId}:{type}:{name}` before calling `idFromName()`, where
+ * `{type}` is `workspace` or `document`.
  * This ensures each user's data is isolated in separate DO instances, even
  * if multiple users create workspaces with the same name (e.g., "epicenter.tab-manager").
```

### Verification

- [x] `bun run typecheck` passes from `apps/api/`
- [x] Grep for old pattern `user:\${c.var.user.id}:\${c.req.param` returns 0 results in `apps/api/src/`
- [x] Grep for new pattern `user:\${c.var.user.id}:workspace:` and `user:\${c.var.user.id}:document:` returns expected results

## Files Changed

- `apps/api/src/app.ts` — `getWorkspaceStub`, `getDocumentStub`, JSDoc
- `apps/api/src/base-sync-room.ts` — JSDoc comment only

## Commit

```
refactor(api): include type segment in DO names

Change DO naming from `user:{userId}:{name}` to
`user:{userId}:{type}:{name}` so names are globally unique across
DO namespaces. Clean break—clients re-sync to new DOs.
```
