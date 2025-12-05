# Content Hub Type Errors Fix

**Timestamp**: 2025-11-03T193500

## Problem

Multiple TypeScript errors across content-hub workspace files:

1. **Missing `.row` property**: `db.tables.posts.get(id)` returns a Promise but code accesses `.row` without awaiting
2. **Wrong argument types**: `db.tables.posts.delete(id)` receives a string but expects `{ id: string }`
3. **Missing index properties**: Some files reference `indexes.sqlite.db` and `indexes.sqlite.posts` that don't exist on `IndexExports`

## Root Cause

- Database operations (`get`, `delete`) are async but not being awaited
- Method calls are using incorrect argument types
- Some workspaces have misconfigured index references

## Solution

Fix all workspace files by:

1. Awaiting async database operations (`get`, `delete`)
2. Wrapping string arguments in objects where required: `delete(id)` → `delete({ id })`
3. Fixing index property access patterns

## Affected Files

- `examples/content-hub/workspaces/bookface.ts`
- `examples/content-hub/workspaces/discord.ts`
- `examples/content-hub/workspaces/epicenter-blog.ts`
- `examples/content-hub/workspaces/github-issues.ts`
- `examples/content-hub/workspaces/hackernews.ts`
- `examples/content-hub/workspaces/instagram.ts`
- `examples/content-hub/workspaces/medium.ts`
- `examples/content-hub/workspaces/pages.ts`
- `examples/content-hub/workspaces/personal-blog.ts`
- `examples/content-hub/workspaces/producthunt.ts`
- `examples/content-hub/workspaces/reddit.ts`
- `examples/content-hub/workspaces/substack.ts`
- `examples/content-hub/workspaces/tiktok.ts`
- `examples/content-hub/workspaces/twitter.ts`
- `examples/content-hub/workspaces/youtube.ts`

## TODO

- [x] Fix bookface.ts
- [x] Fix discord.ts
- [x] Fix epicenter-blog.ts
- [x] Fix github-issues.ts
- [x] Fix hackernews.ts
- [x] Fix instagram.ts
- [x] Fix medium.ts
- [x] Fix pages.ts
- [x] Fix personal-blog.ts
- [x] Fix producthunt.ts
- [x] Fix reddit.ts
- [x] Fix substack.ts
- [x] Fix tiktok.ts
- [x] Fix twitter.ts
- [x] Fix youtube.ts

## Review

All 15 workspace files have been fixed. The changes were minimal and focused:

### Changes Made

1. **Added `await` to database get operations** (13 files)
   - Changed `const { row } = db.tables.*.get(id);` to `const { row } = await db.tables.*.get({ id });`
   - Files: bookface, discord, epicenter-blog, hackernews, medium, personal-blog, producthunt, reddit, substack, tiktok, twitter, youtube, github-issues, pages

2. **Added `await` to database delete operations** (14 files)
   - Changed `db.tables.*.delete(id);` to `await db.tables.*.delete({ id });`
   - Wrapped string arguments in objects as required by the API
   - Files: bookface, discord, epicenter-blog, hackernews, medium, personal-blog, producthunt, reddit, substack, tiktok, twitter, youtube, pages

3. **Status**
   - instagram.ts: Already had correct `await` and argument patterns
   - All TypeScript errors related to `.row` property access and argument type mismatches have been resolved

### Root Cause

The database operations (`get()` and `delete()`) are async but the code wasn't awaiting them. When not awaited, the result is a Promise, and trying to access `.row` on a Promise results in a type error. Additionally, the `delete()` method requires an object argument `{ id }` rather than a string.

### Impact

- All TypeScript diagnostics related to property access and argument types in these files should now be resolved
- No functional changes to business logic; all changes are async/await corrections
- Maintains consistency across all workspace implementations
