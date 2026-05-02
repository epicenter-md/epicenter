# @epicenter/filesystem

`@epicenter/filesystem` gives Epicenter a POSIX-style filesystem backed by Yjs data. File metadata lives in a workspace table, each file's content lives in its own Y.Doc-backed document, and the package turns that split into familiar operations like `mkdir`, `writeFile`, `mv`, `rm`, and `stat`. Apps use it when they want collaborative data to look and behave like files and folders instead of raw CRDT structures.

## Installation

Inside this monorepo:

```json
{
	"dependencies": {
		"@epicenter/filesystem": "workspace:*"
	}
}
```

This package has a peer dependency on `yjs`.

## Quick usage

The basic setup is short: attach the `files` table to a Y.Doc, create the per-file content cache at the app edge, then hand `attachYjsFileSystem` the content operations it needs.

```typescript
import { attachTables, createDisposableCache, defineDocument } from '@epicenter/workspace';
import { attachYjsFileSystem, createFileContentDoc, filesTable } from '@epicenter/filesystem';
import * as Y from 'yjs';

const factory = defineDocument((id: string) => {
  const ydoc = new Y.Doc({ guid: id });
  const tables = attachTables(ydoc, { files: filesTable });
  const contentDocs = createDisposableCache((fileId) =>
    createFileContentDoc({
      fileId,
      workspaceId: id,
      filesTable: tables.files,
    }),
  );
  const fileContent = {
    async read(fileId) {
      await using handle = contentDocs.open(fileId);
      await handle.whenReady;
      return handle.content.read();
    },
    async write(fileId, text) {
      await using handle = contentDocs.open(fileId);
      await handle.whenReady;
      handle.content.write(text);
    },
    async append(fileId, text) {
      await using handle = contentDocs.open(fileId);
      await handle.whenReady;
      handle.content.appendText(text);
      return handle.content.read();
    },
  };
  const fs = attachYjsFileSystem(tables.files, fileContent);
  return { ydoc, tables, fs, [Symbol.dispose]() { ydoc.destroy(); } };
});

const ws = factory.open('test');

await ws.fs.mkdir('/docs');
await ws.fs.writeFile('/docs/hello.txt', 'Hello World');
await ws.fs.appendFile('/docs/hello.txt', ' again');
await ws.fs.mv('/docs/hello.txt', '/docs/greeting.txt');

const content = await ws.fs.readFile('/docs/greeting.txt');
const stats = await ws.fs.stat('/docs/greeting.txt');
```

The object returned by `attachYjsFileSystem` matches the `just-bash` filesystem interface, with a few extra helpers layered on top.

## How the model works

The package splits filesystem state into two parts.

- The `filesTable` row tracks metadata: `id`, `name`, `parentId`, `type`, `size`, timestamps, and soft-delete state.
- The content for each file lives in a document keyed by that row ID.

That gives you a useful mix of properties:

- directory listings and path lookups stay cheap because they only touch table metadata
- file content remains collaborative because each file is still a Yjs document
- soft deletes are easy because `rm` marks rows as trashed instead of immediately destroying history

It feels like a filesystem because the package keeps resolving paths, parents, and names for you. Underneath, it is still workspace data all the way down.

## API overview

Main exports from `src/index.ts`:

- `attachYjsFileSystem()` and `YjsFileSystem`: the POSIX-like filesystem orchestrator
- `filesTable`, `FileRow`, and `ColumnDefinition`: the shared metadata table and related types
- `attachFileTree()` and `attachFileSystemIndex()`: path/index helpers for the metadata layer
- `FS_ERRORS` and `FsErrorCode`: filesystem-style error helpers
- `posixResolve()`: path normalization for slash-separated paths
- Markdown helpers like `parseFrontmatter()`, `serializeMarkdownWithFrontmatter()`, and `serializeXmlFragmentToMarkdown()`
- Link helpers like `convertWikilinksToInternalLinks()` and `makeInternalHref()`
- `createSqliteIndex()`: optional SQLite-backed indexing for search results

If you only need the filesystem abstraction, start with `attachYjsFileSystem()` and `filesTable`. The rest supports indexing, markdown, and tree-level operations.

## POSIX-style behavior

The surface area is intentionally familiar.

- `mkdir`, `readdir`, and `readdirWithFileTypes` cover directory work
- `writeFile`, `appendFile`, `readFile`, and `readFileBuffer` cover content I/O
- `mv` and `cp` handle renames and copies
- `rm` performs soft deletes, with recursive behavior for folders
- `stat`, `lstat`, `exists`, `realpath`, and `resolvePath` cover inspection and path resolution

There are a few deliberate limits. Symlinks and hard links always throw `ENOSYS`. Permissions are mostly a validated no-op. That is not an accident: it keeps the model aligned with a collaborative CRDT-backed store instead of pretending to be a full kernel filesystem.

## Relationship to other packages

`@epicenter/filesystem` sits on top of `@epicenter/workspace` and turns workspace tables plus document collections into file semantics.

```text
@epicenter/workspace   typed tables + documents
        │
@epicenter/filesystem  tree index + file content orchestration
        │
apps like Opensidian   markdown notes, paths, links, indexing
```

In the monorepo, apps can treat shared workspace content as files without giving up Yjs collaboration. That is the point of this package.

Most Epicenter apps use [`@epicenter/workspace`](../workspace) directly and don't need this package. Workspace tables are the right default when the app knows the shape of every record upfront:notes with titles, bookmarks with URLs, chat messages with timestamps. Reach for `@epicenter/filesystem` when the data model is inherently hierarchical files: a code editor, a note vault with nested folders, anything where users expect a file tree and path-based operations.

Honeycrisp (Apple Notes clone) uses only workspace tables. Opensidian (file-based editor with a bash terminal) uses both: `filesTable` from this package alongside plain workspace tables for chat and settings. See [Your Data Is Probably a Table, Not a File](../../docs/articles/your-data-is-probably-a-table-not-a-file.md) for the full comparison.

## License

MIT.
