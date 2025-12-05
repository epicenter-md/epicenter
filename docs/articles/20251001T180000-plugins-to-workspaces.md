# From Plugins to Workspaces: A Mental Model Shift

I hit an interesting architectural decision while building Vault. I started with what I called "Epicenter's original architecture" - a root `epicenter.config.ts` file where you'd define plugins and aggregate them. After months of building with it, I'm ripping that out for something fundamentally different.

## Epicenter's Original Architecture

The pattern followed what you'd see in tools like Drizzle: a root config file that defines everything. You could import plugins from npm or define them locally, then create an app aggregator that combined them all:

```typescript
// epicenter.config.ts (root file)
const usersPlugin = definePlugin({
  id: 'users',
  tables: { users: { ... } },
  methods: { ... }
});

const postsPlugin = definePlugin({
  id: 'posts',
  tables: { posts: { ... } },
  methods: { ... }
});

// Root aggregator that chains everything together
const app = definePlugin({
  id: 'app',
  dependencies: [usersPlugin, postsPlugin],
  tables: {},  // Empty - just aggregating
  methods: () => ({})  // Empty - just passing through
});

// Run the app
const runtime = await runPlugin(app, config);
runtime.users.createUser({ ... });
runtime.posts.createPost({ ... });
```

The problem: plugins are defined in the root config. They can't exist independently. You can't import just `users` without bringing in the entire aggregator.

This pattern felt familiar. It's similar to `drizzle.config.ts` and other centralized config approaches. I built it because that's what made sense at the time.

## What Changed My Mind

Two things converged that made me rethink this entire approach:

1. **Mirroring fractions of workspaces**: I wanted to mirror small fractions of my workspace to other projects. What if I wanted just a few tables from my blog workspace mirrored somewhere else? The monolithic config file made that awkward.

2. **Yjs integration and folder organization**: I was working on Yjs integration for real-time collaboration. Each plugin would need a globally unique ID to serve as the Yjs document ID. But this created a problem: how do you organize plugins as folders? If every plugin needs a truly unique ID, would I include both the name and ID in the folder name? That seemed wrong. I wanted to name folders whatever made sense - `users`, `posts`, `articles` - not `users-a1b2c3d4` or some combination.

Then it hit me: what if each folder had a small config file where I could put the ID and name separately? That way I could name the folder anything I wanted, and the unique ID would live in the config.

But once I'm putting a config file in each folder, those folders become self-contained workspaces. Each one has its own `epicenter.config.ts` with its unique ID, tables, and methods.

That's when the model flipped. Instead of plugins defined in a root config, each folder is a workspace with its own config. The folder name is just for humans. The ID in the config is for Yjs. And workspaces can import other workspaces directly.

You can still have a root `epicenter.config.ts` if you want - but its role is different. It doesn't define the workspaces. It just composes them together into a unified API for convenience. The root merges the workspace APIs together, but it doesn't own them. Each workspace can be used independently.

## The Workspace Model (What I'm Building Now)

Each folder is a complete workspace:

```
my-project/
  users/
    epicenter.config.ts    # Users workspace
    .epicenter/            # System-managed data
      assets/              # Binary blobs (images, files)
      indexes/             # SQLite, vector DBs, etc.
      ydoc.bin             # YJS document persistence
      .gitignore           # Auto-generated
  posts/
    epicenter.config.ts    # Posts workspace
    .epicenter/
      assets/
      indexes/
      ydoc.bin
  comments/
    epicenter.config.ts    # Comments workspace
    .epicenter/
      assets/
      indexes/
      ydoc.bin
```

### Workspace Folder Structure

Each workspace uses a `.epicenter/` folder for all system-managed data:

- **`assets/`**: Binary blobs (audio, video, images) referenced by YJS data. In a transcription app, audio files live here. In a blog, uploaded images go here. These are app-managed files that users interact with through the application.

- **`indexes/`**: Synchronized snapshots for querying (SQLite DBs, vector embeddings, etc.). These can be rebuilt from the YJS document, so they're typically gitignored.

- **`ydoc.bin`**: YJS document persistence. This is the source of truth for all structured data in the workspace. Whether to gitignore this depends on your sync strategy.

- **`.gitignore`**: Auto-generated file that typically ignores `assets/` (large binaries), `indexes/` (rebuildable), and optionally `ydoc.bin` (depends on whether you're using git for sync or a dedicated collaboration provider).

Workspaces import what they need:

```typescript
// comments/epicenter.config.ts
import usersWorkspace from '../users/epicenter.config';
import postsWorkspace from '../posts/epicenter.config';

export default defineWorkspace({
  id: 'f7g8h9i0-j1k2-3456-lmno-pq7890123456',  // Globally unique
  dependencies: [usersWorkspace, postsWorkspace],

  methods: ({ plugins, tables }) => ({
    createComment: async ({ userId, postId, content }) => {
      // Direct access to dependencies
      const user = await plugins.users.getUserById({ userId });
      const post = await plugins.posts.getPostById({ postId });

      return tables.comments.upsert({ ... });
    }
  })
});
```

No central node. No aggregator. Just workspaces depending on workspaces. And here's the key: imports can use full paths from anywhere on your machine.

Want to mirror a workspace to your blog?

```typescript
// In my blog's config
import articlesWorkspace from '/Users/me/projects/vault/articles/epicenter.config';

export default defineWorkspace({
  id: 'blog-abc123',
  dependencies: [articlesWorkspace],  // Direct import from main project
  // ...
});
```

The workspace lives in one place. Multiple projects can import it. Each document in it is collaborative via Yjs.

## What This Enables

### Real Portability

Each folder is self-contained. Copy the `users/` folder to another project? It just works. The workspace ID stays the same, the data travels with it, dependencies are explicit imports. No setup. No registration. Just copy and import.

### Selective Sharing

Working on a team project? Share the `posts/` workspace with the content team. Share the `users/` workspace with the backend team. They don't need the whole project.

### Real-Time Sync at the Right Granularity

Each workspace syncs independently via Yjs. Multiple people can edit the same workspace simultaneously. The workspace ID serves as the Yjs document ID. No coordination layer needed.

### Explicit Dependency Graph

The import statements create the dependency graph:

```typescript
import usersWorkspace from '../users/epicenter.config';
import postsWorkspace from '../posts/epicenter.config';
```

That's your dependency graph. No registry to maintain. No lookup table to configure. No framework magic. Just standard JavaScript imports that work exactly how you'd expect.

## The Mental Model Shift

Here's the thing that took me too long to realize: **plugins and workspaces were becoming indistinguishable**.

I kept calling them plugins because that's what I started with. But once each one had:
- A globally unique ID
- Its own storage
- The ability to depend on others
- Real-time sync capability

...they weren't plugins anymore. They were workspaces.

The central node was just me clinging to the plugin mental model.

## What Changed

The key difference isn't whether there's a root config - it's what the root config does.

**Old model**: The root config defines the plugins. Plugins can't exist without it.

**New model**: Each workspace is self-contained. The root config (if you have one) just composes them into a unified API. It doesn't define them, doesn't own them, doesn't do synchronization logic. It just merges workspace APIs together for convenience.

You can have a root aggregator if you want:

```typescript
// Optional root epicenter.config.ts
import usersWorkspace from './users/epicenter.config';
import postsWorkspace from './posts/epicenter.config';

export default defineWorkspace({
  id: 'app',
  dependencies: [usersWorkspace, postsWorkspace],
  tables: {},
  methods: ({ plugins }) => ({
    // Merged API from all workspaces
    ...plugins.users,
    ...plugins.posts,
  })
});
```

But you don't need it. Each workspace works independently.

## What I Gained

### One Folder = One Workspace = One Team

This is the mental model now. Each workspace is:
- A folder you can move around
- A team's domain
- A Yjs document that syncs
- A set of tables and methods

Root configs are optional and just for API convenience. Workspaces don't need them to exist or be imported.

### Simplicity

Want to use a workspace? Import it:

```typescript
import usersWorkspace from '../users/epicenter.config';
// Or from anywhere on your machine
import articlesWorkspace from '/absolute/path/to/articles/epicenter.config';
```

No registration. No plugin system. No aggregation layer. Just imports.

### Collaboration That Makes Sense

Multiple people editing the same workspace? They're syncing the same Yjs document. Editing different workspaces? Different Yjs documents. The sync granularity matches the code organization.

## The Rename

This realization led to a simple change: `definePlugin` became `defineWorkspace`.

Not just a name. A mental model.

```typescript
// Before
const usersPlugin = definePlugin({ ... });

// After
const usersWorkspace = defineWorkspace({ ... });
```

The code barely changed. But it reads differently now. It's not defining a plugin to be plugged into something. It's defining a workspace that stands alone and happens to depend on other workspaces.

## What's Next

The architecture is set. Now it's Yjs integration:
- Connect each workspace ID to a Yjs document
- Sync table operations through CRDTs
- Handle conflict resolution
- Add presence indicators

But the hard part is done. The hard part was realizing I didn't need the central node at all.

## The Concrete Use Case

Here's where this really pays off: I want my blog to use Astro Content Collections, but pull articles from my main Vault project. Not copy them - actually import the workspace so edits in one place show up in both.

With the old model, I'd need the entire root config. With workspaces:

```typescript
// blog/src/content/config.ts
import articlesWorkspace from '/Users/me/projects/vault/articles/epicenter.config';

export default defineWorkspace({
  id: 'my-blog',
  dependencies: [articlesWorkspace],
  // Blog-specific tables and methods
});
```

Every article in that workspace is collaborative via Yjs. I can edit in my main project or my blog. Changes sync in real-time. The workspace lives in one place but can be imported anywhere.

That's not possible with a central aggregator. The aggregator forces everything through one entry point. Workspaces just reference each other.

## The Lesson

Not every architecture needs a root. Sometimes the most flexible system is the one where everything is equal and dependencies are explicit.

I spent weeks building a plugin system with aggregation because that's the pattern I knew. It took trying to share a workspace across projects to realize the aggregator was the problem, not the solution.

---

The workspace model ships with Vault v2. Each folder is a workspace. Workspaces import workspaces from anywhere on your machine. Root configs are optional for creating unified APIs. The workspaces themselves are self-contained and portable.
