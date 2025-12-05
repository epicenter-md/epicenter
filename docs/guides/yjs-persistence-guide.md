# YJS Persistence Guide: A Beginner-Friendly Introduction

This guide explains how persistence works in Epicenter using the provider pattern and shows you how to make your app work across desktop and web platforms.

## What is YJS?

YJS is a **CRDT (Conflict-free Replicated Data Type)** library. Think of it as a special data structure that:

1. **Tracks every change** to your data (who changed what, when)
2. **Syncs automatically** across multiple users or devices
3. **Resolves conflicts** without losing data (like Google Docs)

In Epicenter, YJS serves as the **source of truth** for all your data. When you insert a row into a table, you're actually updating a YJS document. Epicenter's table helpers are a friendly API wrapper around YJS's lower-level operations.

### The YDoc: Your Database Container

Every workspace has a `Y.Doc` instance. This document:
- Contains all your tables as nested YJS Maps
- Can be serialized to binary format (for saving to disk)
- Can sync with other documents (for collaboration)
- Emits events when data changes (so indexes can update)

```typescript
// Under the hood, this is what happens:
const ydoc = new Y.Doc({ guid: 'my-workspace-id' });

// Your table operations update the YDoc:
db.tables.posts.insert({ id: '1', title: 'Hello' });
// ↓
// YDoc updated → Indexes notified → Files saved
```

## Persistence with Providers

Epicenter uses a provider pattern for persisting your YJS document. Providers are functions that integrate with the workspace lifecycle to set up persistence.

### Desktop Persistence with `setupPersistence`

For desktop applications (Tauri, Electron, Bun), use the built-in `setupPersistence` provider from `@epicenter/hq/providers/desktop`. This provider:
- Automatically saves to `.epicenter/{workspaceId}.yjs` in your project directory
- Loads existing state on startup
- Auto-saves on every update
- Works seamlessly with multiple workspaces

**Example**: Using the built-in provider

```typescript
import { defineWorkspace } from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers/desktop';
import { text, ytext } from '@epicenter/hq';

const blogWorkspace = defineWorkspace({
  id: 'blog',

  // Add the persistence provider
  providers: [setupPersistence],

  schema: {
    posts: {
      title: text(),
      content: ytext({ nullable: true }),
    }
  },

  // ... rest of your config
});

// That's it! Your workspace now auto-saves to .epicenter/blog.yjs
```

### Web Persistence with IndexedDB

For web applications, you'll need to create a custom provider using `y-indexeddb`:

```typescript
import { defineWorkspace } from '@epicenter/hq';
import { text, ytext } from '@epicenter/hq';
import type { Provider } from '@epicenter/hq';
import { IndexeddbPersistence } from 'y-indexeddb';

// Create a web persistence provider
const setupWebPersistence: Provider = async ({ id, ydoc }) => {
  // y-indexeddb handles loading and saving automatically
  new IndexeddbPersistence(id, ydoc);
};

const blogWorkspace = defineWorkspace({
  id: 'blog',

  // Use the web persistence provider
  providers: [setupWebPersistence],

  schema: {
    posts: {
      title: text(),
      content: ytext({ nullable: true }),
    }
  },

  // ... rest of your config
});
```

## Making It Cross-Platform: Isomorphic Code

Providers make cross-platform support easy. The key insight is that all persistence does two things:

1. **Load existing state**: `Y.applyUpdate(ydoc, savedState)`
2. **Save on updates**: `ydoc.on('update', saveFunction)`

The only difference is WHERE you save (filesystem vs IndexedDB). You can abstract this with conditional imports or runtime detection:

### Approach 1: Platform-Specific Imports

```typescript
// persistence.desktop.ts
import type { Provider } from '@epicenter/hq';
export { setupPersistence } from '@epicenter/hq/providers/desktop';
```

```typescript
// persistence.web.ts
import type { Provider } from '@epicenter/hq';
import { IndexeddbPersistence } from 'y-indexeddb';

export const setupPersistence: Provider = async ({ id, ydoc }) => {
  new IndexeddbPersistence(id, ydoc);
};
```

```typescript
// epicenter.config.ts
import { defineWorkspace } from '@epicenter/hq';
// Import the right one based on your platform
import { setupPersistence } from './persistence.desktop';
// or
import { setupPersistence } from './persistence.web';

const workspace = defineWorkspace({
  id: 'blog',
  providers: [setupPersistence],
  // ... rest of config
});
```

### Approach 2: Runtime Detection

```typescript
// persistence.ts
import type { Provider } from '@epicenter/hq';

export const setupPersistence: Provider = async ({ id, ydoc }) => {
  // Detect environment
  const isNode = typeof process !== 'undefined' && process.versions?.node;

  if (isNode) {
    // Desktop: use filesystem provider
    const { setupPersistence: desktopProvider } = await import('@epicenter/hq/providers/desktop');
    await desktopProvider({ id, ydoc });
  } else {
    // Web: use IndexedDB
    const { IndexeddbPersistence } = await import('y-indexeddb');
    new IndexeddbPersistence(id, ydoc);
  }
};
```

## Benefits of the Provider Pattern

The provider pattern in Epicenter offers several advantages:
- **Cross-platform**: Same API works on desktop and web
- **Composable**: Combine multiple providers (persistence + sync)
- **Type-safe**: Full TypeScript support with the `Provider` interface
- **Simple**: Just add to the `providers` array

## Common Patterns and Tips

### 1. Multiple Workspaces, Shared Storage

Each workspace gets its own file, automatically named by workspace ID:

```typescript
import { defineWorkspace } from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers/desktop';

// Workspace A → saves to .epicenter/workspace-a.yjs
const workspaceA = defineWorkspace({
  id: 'workspace-a',
  providers: [setupPersistence],
  // ... schema
});

// Workspace B → saves to .epicenter/workspace-b.yjs
const workspaceB = defineWorkspace({
  id: 'workspace-b',
  providers: [setupPersistence],
  // ... schema
});
```

Both workspaces share the `.epicenter/` directory but have completely isolated state.

### 2. Combining Persistence with Sync

You can use multiple providers on the same workspace:

```typescript
import { defineWorkspace } from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers/desktop';
import type { Provider } from '@epicenter/hq';
import { WebrtcProvider } from 'y-webrtc';

// Create a sync provider
const setupSync: Provider = async ({ id, ydoc }) => {
  new WebrtcProvider('blog-room', ydoc);
};

const workspace = defineWorkspace({
  id: 'blog',
  // Combine multiple providers
  providers: [
    setupPersistence,  // Saves locally
    setupSync,         // Syncs with other users
  ],
  // ... schema
});

// Both work together!
// Changes sync to other users AND save locally
```

### 3. Custom Save Logic

If you need custom save behavior, create your own provider:

```typescript
import type { Provider } from '@epicenter/hq';
import * as Y from 'yjs';

const customPersistence: Provider = async ({ id, ydoc }) => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const filePath = path.join('./.data', `${id}.yjs`);

  // Load existing state
  try {
    const savedState = fs.readFileSync(filePath);
    Y.applyUpdate(ydoc, savedState);
  } catch {
    console.log('Creating new workspace');
  }

  // Debounced save (saves at most once per second)
  let saveTimeout: NodeJS.Timeout | null = null;

  ydoc.on('update', () => {
    if (saveTimeout) clearTimeout(saveTimeout);

    saveTimeout = setTimeout(() => {
      const state = Y.encodeStateAsUpdate(ydoc);
      Bun.write(filePath, state);
    }, 1000);
  });
};
```

### 4. Testing with Persistence

For tests, you can conditionally exclude persistence providers:

```typescript
import { defineWorkspace } from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers/desktop';

const isTest = process.env.NODE_ENV === 'test';

const workspace = defineWorkspace({
  id: 'blog',
  // Only enable persistence in non-test environments
  providers: isTest ? [] : [setupPersistence],
  // ... schema
});
```

## Key Takeaways

1. **YJS is your source of truth** - All data lives in a YJS document
2. **Use the provider pattern** - Add `setupPersistence` to the `providers` array
3. **Desktop**: Use `@epicenter/hq/providers/desktop` for filesystem persistence
4. **Web**: Create a custom provider with `y-indexeddb` for IndexedDB persistence
5. **Cross-platform is easy** - Same provider interface works everywhere
6. **Composable**: Combine multiple providers (persistence + sync) on the same workspace

## Further Reading

- [YJS Documentation](https://docs.yjs.dev/)
- [y-indexeddb Provider](https://github.com/yjs/y-indexeddb)
- [Epicenter Handoff: YJS Persistence Rollout](../docs/handoff-yjs-persistence-rollout.md)
- [Epicenter Examples](../packages/epicenter/examples/)
