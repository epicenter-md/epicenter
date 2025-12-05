# Content Hub Workspace Restructuring

## Problem

The current content hub structure has workspace configs nested in individual directories:

```
content-hub/
  reddit/
    workspace.config.ts
    .epicenter/
  youtube/
    workspace.config.ts
    .epicenter/
  medium/
    workspace.config.ts
    .epicenter/
  ...
```

This creates several issues:
1. Multiple `.epicenter` directories scattered across subdirectories
2. Each workspace config uses `import.meta.dirname` with `path.join()` to construct relative paths
3. More nested directory structure than necessary
4. Harder to see all workspaces at a glance

## Solution

Flatten the workspace configs to the root level and consolidate storage:

```
content-hub/
  workspace.reddit.ts
  workspace.youtube.ts
  workspace.medium.ts
  .epicenter/
    reddit.db
    youtube.db
    medium.db
```

Benefits:
1. Single `.epicenter` directory for all storage
2. All workspace configs visible at root level
3. Simple string paths instead of `path.join(import.meta.dirname, ...)`
4. Cleaner, flatter structure

## Changes Required

### 1. Move and Rename Workspace Configs

For each directory with a `workspace.config.ts`:
- reddit → workspace.reddit.ts
- youtube → workspace.youtube.ts
- medium → workspace.medium.ts
- substack → workspace.substack.ts
- personal-blog → workspace.personal-blog.ts
- epicenter-blog → workspace.epicenter-blog.ts
- twitter → workspace.twitter.ts
- instagram → workspace.instagram.ts
- tiktok → workspace.tiktok.ts
- discord → workspace.discord.ts
- hackernews → workspace.hackernews.ts
- producthunt → workspace.producthunt.ts
- bookface → workspace.bookface.ts
- github-issues → workspace.github-issues.ts
- pages → workspace.pages.ts

### 2. Update Path References

In each workspace config:

**Before:**
```typescript
import { join } from 'node:path';

indexes: {
  sqlite: (db) =>
    sqliteIndex(db, {
      path: join(import.meta.dirname, '.epicenter/database.db'),
    }),
  markdown: (db) =>
    markdownIndex(db, {
      rootPath: join(import.meta.dirname, '.data/content'),
      // ...
    }),
},

providers: [
  setupPersistence({
    storagePath: join(import.meta.dirname, '.epicenter'),
  }),
],
```

**After:**
```typescript
// Remove join import if no longer needed
// import { join } from 'node:path';

indexes: {
  sqlite: (db) =>
    sqliteIndex(db, {
      path: './.epicenter/reddit.db',
    }),
  markdown: (db) =>
    markdownIndex(db, {
      rootPath: './reddit',
      // ...
    }),
},

providers: [
  setupPersistence({
    storagePath: './.epicenter',
  }),
],
```

### 3. Consolidate .epicenter Directories

- Keep only the root `.epicenter` directory
- Delete all subdirectory `.epicenter` folders after migration
- Update database paths to include workspace name: `./.epicenter/reddit.db`, `./.epicenter/youtube.db`, etc.

### 4. Update Markdown Index Paths

For workspaces with markdown indexes (like youtube):
- Change `rootPath` from `join(import.meta.dirname, '.data/content')` to `'./youtube'` (or appropriate subdirectory)
- Keep the same path structure, just simplified

### 5. Clean Up Empty Directories

After moving configs, the subdirectories may be empty or only contain data. Evaluate if they're still needed.

## Todo Items

- [x] Move reddit/workspace.config.ts to workspace.reddit.ts and update paths
- [x] Move youtube/workspace.config.ts to workspace.youtube.ts and update paths
- [x] Move medium/workspace.config.ts to workspace.medium.ts and update paths
- [x] Move substack/workspace.config.ts to workspace.substack.ts and update paths
- [x] Move personal-blog/workspace.config.ts to workspace.personal-blog.ts and update paths
- [x] Move epicenter-blog/workspace.config.ts to workspace.epicenter-blog.ts and update paths
- [x] Move twitter/workspace.config.ts to workspace.twitter.ts and update paths
- [x] Move instagram/workspace.config.ts to workspace.instagram.ts and update paths
- [x] Move tiktok/workspace.config.ts to workspace.tiktok.ts and update paths
- [x] Move discord/workspace.config.ts to workspace.discord.ts and update paths
- [x] Move hackernews/workspace.config.ts to workspace.hackernews.ts and update paths
- [x] Move producthunt/workspace.config.ts to workspace.producthunt.ts and update paths
- [x] Move bookface/workspace.config.ts to workspace.bookface.ts and update paths
- [x] Move github-issues/workspace.config.ts to workspace.github-issues.ts and update paths
- [x] Move pages/workspace.config.ts to workspace.pages.ts and update paths
- [x] Remove subdirectory .epicenter folders (keep only root)
- [ ] Update epicenter.config.ts if it references workspace locations
- [ ] Test all workspaces to ensure they still function correctly
- [ ] Write article explaining the restructuring and reasoning

## Review

### Completed Changes

All 15 workspace configurations have been successfully restructured:

**Moved Files:**
- ✓ workspace.reddit.ts
- ✓ workspace.youtube.ts
- ✓ workspace.medium.ts
- ✓ workspace.substack.ts
- ✓ workspace.personal-blog.ts
- ✓ workspace.epicenter-blog.ts
- ✓ workspace.twitter.ts
- ✓ workspace.instagram.ts
- ✓ workspace.tiktok.ts
- ✓ workspace.discord.ts
- ✓ workspace.hackernews.ts
- ✓ workspace.producthunt.ts
- ✓ workspace.bookface.ts
- ✓ workspace.github-issues.ts
- ✓ workspace.pages.ts

**Path Updates:**
1. Changed imports from `../shared/schemas` to `./shared/schemas`
2. Replaced `join(import.meta.dirname, '.epicenter/database.db')` with `path.join('.epicenter', 'workspace-name.db')`
3. Updated markdown index paths from `join(import.meta.dirname, '.data/content')` to `'./workspace-name'`
4. Changed persistence storage from `join(import.meta.dirname, '.epicenter')` to `'./.epicenter'`
5. For simpler configs, removed unnecessary `join` import

**Storage Consolidation:**
- Removed all subdirectory `.epicenter` folders
- Single root `.epicenter` directory now contains all workspace databases
- Each workspace has a uniquely named database file (e.g., `reddit.db`, `youtube.db`)

**Final Structure:**
```
content-hub/
  workspace.bookface.ts
  workspace.discord.ts
  workspace.epicenter-blog.ts
  workspace.github-issues.ts
  workspace.hackernews.ts
  workspace.instagram.ts
  workspace.medium.ts
  workspace.pages.ts
  workspace.personal-blog.ts
  workspace.producthunt.ts
  workspace.reddit.ts
  workspace.substack.ts
  workspace.tiktok.ts
  workspace.twitter.ts
  workspace.youtube.ts
  .epicenter/           # Single storage directory
  shared/               # Shared schemas and utilities
  ...other files
```

### Benefits Achieved

1. **Visibility**: All workspace configurations are now immediately visible at the root level
2. **Simplicity**: Reduced path complexity by removing `import.meta.dirname` usage
3. **Organization**: Single `.epicenter` directory makes it clear where all persistent data lives
4. **Consistency**: All workspaces follow the same naming pattern (`workspace.{name}.ts`)
5. **Maintainability**: Easier to locate and modify workspace configurations
