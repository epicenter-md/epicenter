# Vault: Collaborative Workspace System

## Vision

Transform Vault from a plugin system into a **collaborative workspace framework** where each folder containing an `epicenter.config.ts` file represents a self-contained, globally synchronizable workspace.

## Core Concepts

### Folder-Based Workspaces

Each folder with `epicenter.config.ts` is a complete, portable workspace:

```
my-project/
  users/
    epicenter.config.ts    # Users workspace (globally unique ID)
    data/                  # Local storage for this workspace
  posts/
    epicenter.config.ts    # Posts workspace (globally unique ID)
    data/
  comments/
    epicenter.config.ts    # Comments workspace (globally unique ID)
    data/
```

### Globally Unique IDs

The `id` field in each `epicenter.config.ts` serves as:
- A globally unique identifier for the workspace (UUID or nanoid)
- The Yjs document ID for real-time collaboration
- A stable reference for cross-workspace dependencies

```typescript
// users/epicenter.config.ts
export default defineWorkspace({
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', // Globally unique Yjs document ID
  tables: { ... },
  methods: ({ tables }) => ({ ... })
});
```

### Real-Time Collaboration

Each workspace can be synchronized across multiple users via Yjs and a collaboration provider like Hocuspocus:

```typescript
import { runPlugin } from '@epicenter/vault';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

// Load workspace config
const workspace = await import('./users/epicenter.config.ts');

// Create Yjs document with workspace ID
const ydoc = new Y.Doc({ guid: workspace.default.id });

// Connect to collaboration server
const provider = new HocuspocusProvider({
  url: 'wss://collab.example.com',
  name: workspace.default.id, // Use workspace ID as document name
  document: ydoc
});

// Run plugin with sync enabled
const api = await runPlugin(workspace.default, {
  databaseUrl: './users/data/db.sqlite',
  storagePath: './users/data',
  yjsDoc: ydoc // Enable Yjs sync
});
```

### Cross-Workspace Dependencies

Workspaces can depend on other workspaces by importing their configs:

```typescript
// comments/epicenter.config.ts
import usersWorkspace from '../users/epicenter.config';
import postsWorkspace from '../posts/epicenter.config';

export default defineWorkspace({
  id: 'f7g8h9i0-j1k2-3456-lmno-pq7890123456',
  dependencies: [usersWorkspace, postsWorkspace],
  tables: {
    comments: { ... }
  },
  methods: ({ plugins, tables }) => ({
    createComment: defineMutation({
      handler: async ({ userId, postId, content }) => {
        // Validate user exists in users workspace
        const user = await plugins.users.getUserById({ userId });

        // Validate post exists in posts workspace
        const post = await plugins.posts.getPostById({ postId });

        // Create comment in local workspace
        return tables.comments.upsert({ ... });
      }
    })
  })
});
```

## Workspace Portability

Each workspace folder is **completely portable**:

1. **Copy/paste folders** between projects
2. **Share folders** via git, sync services, or direct transfer
3. **Collaborate** on individual workspaces without sharing the entire project
4. **Version control** each workspace independently

## Multi-User Scenarios

### Scenario 1: Team Collaboration
Multiple developers work on the same workspace simultaneously:
- User A adds a new user record
- User B sees the change in real-time via Yjs
- Both SQLite and markdown files stay in sync

### Scenario 2: Offline-First
Work offline and sync when reconnected:
- Make changes locally while offline
- Changes saved to local SQLite and markdown
- Yjs syncs changes when connection restored
- Conflicts resolved automatically via CRDT

### Scenario 3: Selective Sharing
Share only specific workspaces:
- Share `users/` folder with backend team
- Share `posts/` folder with content team
- Each team works on their workspace independently
- Dependencies stay synchronized

## Implementation Plan

### Phase 1: Documentation
- [x] Rename `definePlugin` to `defineWorkspace`
- [x] Update `defineWorkspace` JSDoc to explain workspace IDs
- [x] Update README with collaborative workspace concepts
- [x] Add examples showing folder structure

### Phase 2: Yjs Integration (Future)
- [ ] Add Yjs document support to `runPlugin`
- [ ] Implement CRDT-based table operations
- [ ] Add conflict resolution strategies
- [ ] Create Hocuspocus adapter

### Phase 3: Collaboration Features (Future)
- [ ] Real-time presence indicators
- [ ] Operation history and undo/redo
- [ ] Workspace permissions and access control
- [ ] Multi-workspace transactions

## Technical Considerations

### ID Generation
- Use `nanoid()` or `uuid()` for generating workspace IDs
- IDs must be globally unique to avoid sync conflicts
- Consider hierarchical IDs for namespacing: `org.team.workspace`

### Storage Sync
- SQLite operations must be reflected in Yjs doc
- Markdown files remain human-readable source of truth
- Yjs doc serves as sync layer, not storage layer

### Dependency Resolution
- Import statements create explicit dependency graph
- Circular dependencies should be prevented
- Workspace initialization order determined by dependency tree

## Benefits

1. **True Portability**: Each folder is self-contained and moveable
2. **Real-Time Collaboration**: Multiple users can edit simultaneously
3. **Offline Support**: Work continues without connection
4. **Flexible Sharing**: Share individual workspaces, not entire projects
5. **Simple Mental Model**: One folder = one workspace = one team

## Todo Items
- [x] Create this spec document
- [x] Rename definePlugin to defineWorkspace
- [x] Update plugin.ts JSDoc
- [x] Update methods.ts JSDoc
- [x] Update README with workspace concepts
- [x] Add Yjs integration examples (conceptual)
- [x] Update ID validation to support UUIDs/nanoids
