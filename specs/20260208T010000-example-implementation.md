# Yjs Filesystem Example Implementation

**Date**: 2026-02-08T01:00:00
**Status**: Reference Implementation
**Related**: [20260208T000000-yjs-filesystem-spec.md](./20260208T000000-yjs-filesystem-spec.md)

## Overview

This document shows a minimal working implementation of the Yjs filesystem with 3 components syncing via Y-Sweet:

1. **Y-Sweet Server**: CRDT orchestration
2. **Bun Process**: Bidirectional filesystem sync (Yjs ↔ native FS)
3. **Svelte App**: File browser and editor UI

All components connect to the same Y-Sweet server. Changes propagate automatically.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Y-Sweet Server                          │
│                   ws://localhost:8080                       │
│                                                             │
│  Docs:                                                      │
│  • ws://localhost:8080/d/workspace-main-0/ws (files table) │
│  • ws://localhost:8080/d/file-abc123/ws      (content doc) │
│  • ws://localhost:8080/d/file-def456/ws      (content doc) │
│  • ... (one per file)                                       │
└─────────────────────────────────────────────────────────────┘
           ↑                    ↑                    ↑
           │                    │                    │
    ┌──────┴──────┐      ┌─────┴──────┐      ┌─────┴──────┐
    │  Bun Process │      │ Svelte App │      │ Another    │
    │  (FS Sync)   │      │ (Browser)  │      │ Browser    │
    │              │      │            │      │            │
    │  Watches:    │      │  Shows:    │      │  Shows:    │
    │  ./data/     │      │  • Files   │      │  • Files   │
    │              │      │  • Editor  │      │  • Editor  │
    │  Syncs:      │      │            │      │            │
    │  Yjs ↔ FS    │      │            │      │            │
    └──────────────┘      └────────────┘      └────────────┘
```

**Key insight**: Each peer connects to the same doc URLs. Y-Sweet handles CRDT merge. Changes in one peer appear instantly in all others.

---

## Component 1: Y-Sweet Server

**Start local server**:
```bash
npx y-sweet@latest serve ./y-sweet-data
```

**What this does**:
- Runs WebSocket server on `ws://127.0.0.1:8080`
- Stores CRDT state in `./y-sweet-data/`
- Handles sync for all connected docs

**Production setup**: Deploy y-sweet to a server, use authenticated mode with tokens. For dev/testing, direct mode (no auth) is fine.

---

## Component 2: Bun Process (Filesystem Sync)

**File**: `scripts/fs-sync.ts`

### Reusable Library Code

These patterns should live in `@epicenter/workspace` for reuse:

```typescript
// packages/epicenter/src/filesystem/sync-coordination.ts
export class SyncCoordination {
  private yjsWriteCount = 0;
  private fileChangeCount = 0;

  async withYjsWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.yjsWriteCount++;
    try {
      return await fn();
    } finally {
      this.yjsWriteCount--;
    }
  }

  async withFileChange<T>(fn: () => Promise<T>): Promise<T> {
    this.fileChangeCount++;
    try {
      return await fn();
    } finally {
      this.fileChangeCount--;
    }
  }

  get shouldSkipYjsWrite() { return this.fileChangeCount > 0; }
  get shouldSkipFileChange() { return this.yjsWriteCount > 0; }
}
```

```typescript
// packages/epicenter/src/filesystem/content-doc-manager.ts
import * as Y from 'yjs';
import { createYjsProvider } from '@y-sweet/client';

export class ContentDocManager {
  private docs = new Map<string, ContentDoc>();

  constructor(private serverUrl: string) {}

  open(fileId: string): ContentDoc {
    if (this.docs.has(fileId)) return this.docs.get(fileId)!;

    const ydoc = new Y.Doc({ guid: fileId, gc: false });

    // Each file gets its own provider connection
    const provider = createYjsProvider(ydoc, fileId, async () => {
      const url = new URL(this.serverUrl);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return {
        url: `${wsProtocol}//${url.host}/d/${fileId}/ws`,
        baseUrl: `${url.protocol}//${url.host}`,
        docId: fileId,
        token: undefined,
      };
    });

    const doc = {
      ydoc,
      provider,
      destroy: () => this.cleanup(fileId)
    };
    this.docs.set(fileId, doc);
    return doc;
  }

  private cleanup(fileId: string) {
    const doc = this.docs.get(fileId);
    if (!doc) return;
    doc.provider.destroy();
    doc.ydoc.destroy();
    this.docs.delete(fileId);
  }

  closeAll() {
    for (const fileId of this.docs.keys()) {
      this.cleanup(fileId);
    }
  }
}

type ContentDoc = {
  ydoc: Y.Doc;
  provider: any;
  destroy: () => void;
};
```

```typescript
// packages/epicenter/src/filesystem/bidirectional-sync.ts
import chokidar from 'chokidar';

export function createBidirectionalSync(options: {
  workspace: Workspace;
  directory: string;
  contentDocManager: ContentDocManager;
}) {
  const coordination = new SyncCoordination();

  // YJS → Filesystem
  const unobserve = options.workspace.tables.files.observe(async (changedIds) => {
    if (coordination.shouldSkipYjsWrite) return;

    await coordination.withYjsWrite(async () => {
      for (const id of changedIds) {
        const { row } = options.workspace.tables.files.get(id);
        if (!row || row.trashedAt) continue;

        const path = computePath(row);

        if (row.type === 'file') {
          const { ydoc } = options.contentDocManager.open(row.id);
          const content = ydoc.getText('text').toString();
          await Bun.write(`${options.directory}${path}`, content);
        }
      }
    });
  });

  // Filesystem → YJS
  const watcher = chokidar.watch(options.directory, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 500,  // File stable for 500ms
      pollInterval: 100
    },
    ignored: [/(^|[/\\])\../, /\.swp$/],
  });

  watcher.on('change', async (filePath) => {
    if (coordination.shouldSkipFileChange) return;

    await coordination.withFileChange(async () => {
      const fileId = lookupFileIdByPath(filePath);
      if (!fileId) return;

      const content = await Bun.file(filePath).text();
      const { ydoc } = options.contentDocManager.open(fileId);
      const text = ydoc.getText('text');
      text.delete(0, text.length);
      text.insert(0, content);
    });
  });

  return {
    destroy: () => {
      unobserve();
      watcher.close();
    },
  };
}
```

### Minimal Application Code

With the library code above, the application becomes simple:

```typescript
// scripts/fs-sync.ts
import { defineWorkspace, defineTable, createWorkspace } from '@epicenter/workspace/static';
import { ySweetSync } from '@epicenter/workspace/extensions';
import { ContentDocManager, createBidirectionalSync } from '@epicenter/workspace/filesystem';
import { type } from 'arktype';

// 1. Define workspace
const filesTable = defineTable(type({
  id: 'string',
  name: 'string',
  parentId: 'string | null',
  type: "'file' | 'folder'",
  size: 'number',
  createdAt: 'number',
  updatedAt: 'number',
  trashedAt: 'number | null',
}));

const workspace = defineWorkspace({
  id: 'filesystem',
  tables: { files: filesTable },
});

// 2. Create workspace with Y-Sweet sync
const ws = createWorkspace(workspace, {
  extensions: {
    sync: ySweetSync({
      mode: 'direct',
      serverUrl: 'http://127.0.0.1:8080',
      workspaceId: 'workspace-main-0',
    }),
  },
});

await ws.extensions.sync.whenSynced;
console.log('✓ Connected to Y-Sweet');

// 3. Setup bidirectional sync
const contentDocs = new ContentDocManager('http://127.0.0.1:8080');
const sync = createBidirectionalSync({
  workspace: ws,
  directory: './data',
  contentDocManager: contentDocs,
});

console.log('✓ Filesystem sync running');
```

**Run it**:
```bash
bun scripts/fs-sync.ts
```

---

## Component 3: Svelte App (File Browser UI)

**File**: `src/routes/+page.svelte`

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { defineWorkspace, createWorkspace } from '@epicenter/workspace/static';
  import { ySweetSync } from '@epicenter/workspace/extensions';
  import { ContentDocManager } from '@epicenter/workspace/filesystem';
  import * as Y from 'yjs';

  // Same workspace definition as backend
  const workspace = defineWorkspace(/* ... */);

  let ws: ReturnType<typeof createWorkspace>;
  let contentDocs: ContentDocManager;
  let files = $state<any[]>([]);
  let selectedFile = $state<string | null>(null);
  let editor = $state<Y.Text | null>(null);

  onMount(async () => {
    // Connect to same Y-Sweet server
    ws = createWorkspace(workspace, {
      extensions: {
        sync: ySweetSync({
          mode: 'direct',
          serverUrl: 'http://127.0.0.1:8080',
          workspaceId: 'workspace-main-0',
        }),
      },
    });

    await ws.extensions.sync.whenSynced;
    console.log('✓ Svelte app connected');

    contentDocs = new ContentDocManager('http://127.0.0.1:8080');

    // Load files
    loadFiles();

    // Watch for changes
    ws.tables.files.observe(() => loadFiles());
  });

  function loadFiles() {
    const allFiles = ws.tables.files.getAll();
    files = allFiles
      .filter(({ row }) => row && !row.trashedAt && row.parentId === null)
      .map(({ row }) => row);
  }

  async function openFile(fileId: string) {
    const { ydoc } = contentDocs.open(fileId);
    editor = ydoc.getText('text');
    selectedFile = fileId;
  }

  function createFile() {
    const id = generateGuid();
    ws.tables.files.set({
      id,
      name: 'new-file.txt',
      parentId: null,
      type: 'file',
      size: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      trashedAt: null,
    });

    openFile(id);
  }
</script>

<div class="app">
  <aside>
    <h2>Files</h2>
    <button onclick={createFile}>+ New File</button>
    <ul>
      {#each files as file}
        <li>
          <button onclick={() => openFile(file.id)}>
            {file.name}
          </button>
        </li>
      {/each}
    </ul>
  </aside>

  <main>
    {#if editor}
      <textarea
        value={editor.toString()}
        oninput={(e) => {
          const pos = e.target.selectionStart;
          editor.delete(0, editor.length);
          editor.insert(0, e.target.value);
          e.target.setSelectionRange(pos, pos);
        }}
      />
    {:else}
      <p>Select a file to edit</p>
    {/if}
  </main>
</div>

<style>
  .app { display: flex; height: 100vh; }
  aside { width: 300px; border-right: 1px solid #ccc; padding: 1rem; }
  main { flex: 1; padding: 1rem; }
  textarea { width: 100%; height: 100%; font-family: monospace; }
</style>
```

---

## How Data Flows

### Scenario 1: User types in Svelte app

1. **User types** → `editor.insert(0, 'Hello')` → Y.Text change
2. **Y.Text change** → Yjs creates CRDT operation
3. **CRDT operation** → sent to Y-Sweet via WebSocket (`ws://localhost:8080/d/file-abc123/ws`)
4. **Y-Sweet** → broadcasts to all peers (Bun process + other browsers)
5. **Bun process** → receives update → `coordination.withYjsWrite()` → writes to `./data/file.txt`
6. **chokidar sees change** → but `shouldSkipFileChange === true` → no loop

### Scenario 2: User edits file in VS Code

1. **Save file.txt** → chokidar detects change
2. **`shouldSkipFileChange === false`** → proceeds
3. **Read file content** → `coordination.withFileChange()` → update Y.Text
4. **Y.Text change** → sent to Y-Sweet → all browsers update automatically

### Scenario 3: Two users edit simultaneously

1. **Browser A** types "Hello" at position 0
2. **Browser B** types "World" at position 0
3. **Y-Sweet receives both** → Yjs CRDT merge algorithm resolves conflict
4. **All peers converge** to same state (e.g., "HelloWorld" or "WorldHello" based on CRDT rules)
5. **No infinite loops**: coordination counters prevent re-processing same change

---

## Key Implementation Patterns

### 1. Provider Attachment

Each Y.Doc (main + content docs) gets its own provider:

```typescript
// Main doc
ySweetSync({
  serverUrl: 'http://127.0.0.1:8080',
  workspaceId: 'workspace-main-0',  // → ws://localhost:8080/d/workspace-main-0/ws
});

// Content doc
const provider = createYjsProvider(ydoc, fileId, async () => ({
  url: `ws://127.0.0.1:8080/d/${fileId}/ws`,  // Different URL per file
  baseUrl: 'http://127.0.0.1:8080',
  docId: fileId,
  token: undefined,
}));
```

### 2. Sync Coordination (Counter-Based)

**Critical**: Use counters, not booleans. Prevents race conditions with concurrent async operations.

```typescript
// ✅ CORRECT (counters)
syncState.yjsWriteCount++;  // Increment
try { await writeFile(); }
finally { syncState.yjsWriteCount--; }  // Decrement

// ❌ WRONG (boolean)
syncState.isWriting = true;
await writeFile();
syncState.isWriting = false;  // Bug: overlapping async operations break this
```

### 3. File Watcher Configuration

**Must have** `awaitWriteFinish` for bulk operations:

```typescript
chokidar.watch(dir, {
  awaitWriteFinish: {
    stabilityThreshold: 500,  // File stable for 500ms
    pollInterval: 100,        // Check every 100ms
  },
  ignored: [/(^|[/\\])\../, /\.swp$/],  // Ignore dotfiles, vim swaps
});
```

### 4. Content Doc Cleanup

When closing a file:

```typescript
destroy() {
  provider.destroy();  // Close WebSocket
  ydoc.destroy();      // Clean up CRDT state
  docs.delete(fileId); // Remove from manager
}
```

---

## Testing the Implementation

### Start all components

```bash
# Terminal 1: Y-Sweet server
npx y-sweet serve ./y-sweet-data

# Terminal 2: Bun filesystem sync
bun scripts/fs-sync.ts

# Terminal 3: Svelte app
bun run dev
```

### Test bidirectional sync

1. **Open Svelte app** in browser (`http://localhost:5173`)
2. **Create a file** → click "+ New File" → type "Hello from browser"
3. **Check `./data/`** → file should appear on disk with correct content
4. **Edit in VS Code** → open `./data/new-file.txt` → change to "Hello from VS Code"
5. **Check browser** → Svelte app updates automatically

### Test multi-peer sync

1. **Open 2 browser tabs** (both at `http://localhost:5173`)
2. **Edit in tab 1** → type "Tab 1 says hi"
3. **Check tab 2** → sees "Tab 1 says hi" instantly
4. **Edit in tab 2** → type " and tab 2 says hello back"
5. **Check tab 1** → sees full message instantly

---

## Production Considerations

### Y-Sweet Deployment

**Development**: Direct mode (no auth)
```typescript
ySweetSync({
  mode: 'direct',
  serverUrl: 'http://127.0.0.1:8080',
  workspaceId: 'workspace-main-0',
});
```

**Production**: Authenticated mode with tokens
```typescript
ySweetSync({
  mode: 'authenticated',
  authEndpoint: async () => {
    const res = await fetch('/api/y-sweet/token', {
      method: 'POST',
      body: JSON.stringify({ docId: 'workspace-main-0' }),
    });
    return res.json();
  },
});
```

### Content Doc Lifecycle

**Memory management**: Close content docs when not in use
```typescript
// Reference counting
class ContentDocManager {
  private refCounts = new Map<string, number>();

  open(fileId: string) {
    this.refCounts.set(fileId, (this.refCounts.get(fileId) || 0) + 1);
    // ...
  }

  close(fileId: string) {
    const count = this.refCounts.get(fileId) || 0;
    if (count <= 1) {
      this.cleanup(fileId);  // Last reference, destroy
    } else {
      this.refCounts.set(fileId, count - 1);
    }
  }
}
```

### Error Handling

**Non-fatal diagnostics** (pattern from `markdown.ts`):
```typescript
const diagnostics = new DiagnosticsManager();

watcher.on('change', async (filePath) => {
  try {
    await processFile(filePath);
  } catch (error) {
    diagnostics.add({
      filePath,
      error: error.message,
      timestamp: Date.now(),
    });
    // Don't crash: log and continue
  }
});

// Write diagnostics to JSON for debugging
await Bun.write('./diagnostics.json', JSON.stringify(diagnostics.getAll()));
```

---

## References

- **Main spec**: [20260208T000000-yjs-filesystem-spec.md](./20260208T000000-yjs-filesystem-spec.md)
- **Sync coordination pattern**: `packages/epicenter/src/extensions/markdown/markdown.ts` (lines 84-121)
- **Provider attachment**: `packages/epicenter/src/extensions/y-sweet-sync.ts` (lines 131-160)
- **Content doc lifecycle**: `packages/epicenter/src/extensions/revision-history/local.ts` (lines 407-418)
- **Bidirectional sync**: `packages/epicenter/src/extensions/markdown/markdown.ts` (51KB production implementation)
