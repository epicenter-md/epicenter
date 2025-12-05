# Flattening the Content Hub: Why I Moved 15 Workspace Configs to Root Level

I've been building a content hub example for Epicenter that manages content distribution across 15 platforms: Reddit, YouTube, Medium, Twitter, you name it. Each platform gets its own workspace with schemas, actions, and persistence.

Originally, I organized it the way you'd organize most multi-workspace projects. Each workspace lived in its own subdirectory:

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

Made sense, right? Each workspace is a self-contained unit. Keep it isolated in its own directory.

But after working with this structure for a while, I hit some friction that wasn't immediately obvious. The problem wasn't technical debt or performance. It was cognitive load.

## The Hidden Cost of Subdirectories

When you open the content hub directory, you see a list of folder names. To understand what workspaces exist, you have to mentally enumerate them. Reddit, check. YouTube, check. Did I create that Medium workspace yet?

Every time I wanted to modify a workspace configuration, I had to navigate into the subdirectory. `cd reddit`, open `workspace.config.ts`, make the change, back out. It's a small action, but it adds up.

More importantly, it obscured something fundamental about what these workspaces actually are. They're not independent modules with their own concerns. They're peers. They're all variations of the same pattern: take content, apply platform-specific transformations, track distribution.

Reddit is not fundamentally different from YouTube. They both store posts with metadata. They both have the same CRUD operations. They both need persistence. The only differences are the specific fields they track.

So why was I treating them like separate modules with their own boundaries?

## The Path Management Tax

Here's what path references looked like in the old structure:

```typescript
import { join } from 'node:path';

indexes: {
  sqlite: (db) =>
    sqliteIndex(db, {
      path: join(import.meta.dirname, '.epicenter/database.db'),
    }),
},

providers: [
  setupPersistence({
    storagePath: join(import.meta.dirname, '.epicenter'),
  }),
],
```

Every workspace config needed `import.meta.dirname` to figure out where it lived. Then use `join()` to construct paths relative to that location.

This is what you do when your config file could be anywhere. You need dynamic path resolution because you don't know at compile time where the file will be.

But these configs aren't going to be anywhere. They're always going to be in the content hub directory. So why am I paying the complexity tax of dynamic path construction?

## Scattered Persistence

The `.epicenter` folders were scattered across 15 subdirectories. Each workspace had its own storage location.

This meant:
- Where's the Reddit database? `reddit/.epicenter/database.db`
- Where's the YouTube database? `youtube/.epicenter/database.db`
- Where's the Medium database? `medium/.epicenter/database.db`

Fifteen different places to look for persistent data.

And here's the thing: I never needed them to be separate. They weren't separate for isolation purposes. Each workspace already has a unique ID. The database files don't conflict.

The separation was purely an artifact of the directory structure. Not a deliberate architectural decision.

## The Refactoring Decision

I started thinking about what I actually wanted when working with this content hub:

1. **See all workspaces at a glance**: Open the directory, see every workspace config immediately
2. **Simple, predictable paths**: No dynamic resolution, just straightforward relative paths
3. **One obvious place for persistent data**: Single `.epicenter` directory, no guessing

The solution was to flatten everything. Move all workspace configs to the root level with a clear naming convention:

```
content-hub/
  workspace.reddit.ts
  workspace.youtube.ts
  workspace.medium.ts
  workspace.substack.ts
  workspace.twitter.ts
  ...
  .epicenter/
    reddit.db
    youtube.db
    medium.db
    ...
```

Now every workspace is visible in the root directory listing. The `workspace.` prefix makes them easy to identify. The name makes it clear what platform each one handles.

## What Changed in the Code

The path updates were straightforward. Here's what reddit's configuration looks like now:

```typescript
import path from 'node:path';

indexes: {
  sqlite: (db) =>
    sqliteIndex(db, {
      path: path.join('.epicenter', 'reddit.db'),
    }),
},

providers: [
  setupPersistence({
    storagePath: './.epicenter',
  }),
],
```

No more `import.meta.dirname`. No more trying to figure out where the config file lives. Just simple string paths that work from the content hub root.

The database path includes the workspace name: `reddit.db`, `youtube.db`, `medium.db`. This makes it clear which file belongs to which workspace when you look in the `.epicenter` directory.

For workspaces with markdown indexes (like YouTube, which stores video transcripts), the paths became even simpler:

```typescript
// Before
markdownIndex(db, {
  rootPath: join(import.meta.dirname, '.data/content'),
})

// After
markdownIndex(db, {
  rootPath: './youtube',
})
```

The import in `epicenter.config.ts` also cleaned up:

```typescript
// Before
import { reddit } from './reddit/workspace.config';
import { youtube } from './youtube/workspace.config';
import { medium } from './medium/workspace.config';

// After
import { reddit } from './workspace.reddit';
import { youtube } from './workspace.youtube';
import { medium } from './workspace.medium';
```

Shorter imports. No nested directories. The names immediately tell you what you're importing.

## What This Actually Improved

**Discoverability**: Every workspace is now visible at the root level. I can see all 15 platforms with one directory listing. No need to remember what subdirectories exist.

**Path Simplicity**: All paths are relative to a single, known location. No dynamic resolution. When I read `./.epicenter/reddit.db`, I know exactly where that file is.

**Maintenance**: Want to add a new workspace? Create `workspace.newplatform.ts` at root. Copy an existing one as a template. Update the schema. Done. No new directories to create.

**Mental Model**: The flat structure reinforces what these workspaces actually are. They're peers, not independent modules. They're a collection that belongs together.

## When Not to Flatten

This structure works because all 15 workspaces are truly peers. They're variations of the same pattern, applied to different platforms.

If your workspaces have genuinely different concerns (a blog workspace, an authentication workspace, a payment processing workspace), subdirectories might make more sense. You're not just repeating a pattern; you're organizing distinct domains.

But when you have a collection of similar things (platform integrations, data sources, content types), flattening them can reduce cognitive overhead.

## The Lesson

Not every architectural decision needs deep nesting. Sometimes the simpler structure is actually the better structure.

When I started, subdirectories felt like proper organization. Each workspace is its own thing, so give it its own space.

But organization isn't just about isolation. It's about making the structure match how you think about the code.

In a content hub, I don't think "let me go into the reddit module and modify something." I think "let me adjust the reddit workspace along with a few others while I'm at it."

The flat structure supports that mental model. All the workspaces are right there, visible, ready to work with.

Sometimes the best refactoring isn't adding abstraction. It's removing unnecessary structure that doesn't carry its weight.
