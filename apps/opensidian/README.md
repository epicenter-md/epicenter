# Opensidian

Opensidian is a local-first note-taking app with a built-in bash terminal and real-time sync. Your notes live in a CRDT-backed virtual filesystem that a shell can write to just as easily as the editor can. Try it at [opensidian.com](https://opensidian.com).

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│      SvelteKit UI (CodeMirror, File Tree, Terminal)      │
├──────────────────────────────────────────────────────────┤
│  @epicenter/filesystem (POSIX ops, file tree, soft del)  │
├──────────────────────────────────────────────────────────┤
│  @epicenter/workspace (Yjs CRDTs, versioned tables)      │
├──────────────────────────────────────────────────────────┤
│  Extensions: IndexedDB, WebSocket sync, SQLite FTS,      │
│  markdown materializer                                   │
├──────────────────────────────────────────────────────────┤
│  Yjs (Y.Doc, Y.Array, Y.Map, Y.Text)                    │
└──────────────────────────────────────────────────────────┘
```

The key design decision: Yjs CRDTs are the single source of truth, not the database. Every file is a Y.Doc. The filesystem is a versioned Yjs table. SQLite, IndexedDB, and the sync server are all downstream consumers of that CRDT state. They can be rebuilt from scratch at any time.

---

## How it works

### CRDT filesystem

Every file is a Yjs document. The filesystem itself is a versioned table with columns for `id`, `name`, `parentId`, `type`, `size`, and timestamps. File content lives in separate per-file Y.Docs, so a large note doesn't bloat the directory index. Deletes are soft. Files get a `trashedAt` timestamp rather than disappearing from the CRDT, which means concurrent deletes and edits resolve cleanly instead of causing conflicts.

The `@epicenter/filesystem` package wraps this with POSIX-style operations: `mkdir`, `mv`, `rm`, `stat`, and so on. The file tree in the UI and the bash terminal both go through the same layer.

### The terminal

The terminal runs [just-bash](https://github.com/nicolo-ribaudo/just-bash): a full bash interpreter written in TypeScript, with over 80 Unix commands including `awk`, `sed`, `grep`, `jq`, `sort`, `find`, `tar`, `sqlite3`, `curl`, and `xargs`. It's wired directly to the CRDT filesystem, so shell operations and editor operations are the same thing.

```bash
$ echo "# Meeting notes" > /notes/2026-04-06.md
$ mkdir /notes/archive
$ mv /notes/2026-04-06.md /notes/archive/
```

Each of those commands creates or moves a real file that immediately appears in the editor's file tree. There's also a custom `open <path>` command that navigates the editor to a file. If you're the kind of person who reaches for the terminal to organize files, you don't have to context-switch.

### Editor

The editor is CodeMirror 6 with a Yjs binding via `y-codemirror.next`. Undo and redo go through Yjs rather than CodeMirror's own history, so they're CRDT-aware and work correctly across devices. Vim mode is available and toggleable; the preference persists across sessions. Language detection is automatic based on file extension, with custom highlighting for markdown.

Internal links use `[[` autocomplete: typing `[[` opens a file picker, and selecting a file inserts `[File Name](id:GUID)`. The link stores the file's ID rather than its path, so renaming or moving the target doesn't break it. Links render as clickable decorations in the editor and navigate to the target file on click.

### Sync

Sync uses the Yjs protocol (STEP1/STEP2/UPDATE messages) over WebSocket, with exponential backoff and jitter on reconnect. A BroadcastChannel handles tab-to-tab sync within the same browser without going through the server. The server side runs on Cloudflare Durable Objects with a SQLite update log and auto-compaction.

The relay reads plaintext: it runs Yjs and applies your updates, which is what makes server-side search and AI possible. Epicenter Cloud holds your data inside its trust boundary; self-host the sync server and the only machine holding it is yours. IndexedDB is principal-scoped and is only deleted by the explicit "Forget this device" action.

### Search

Full-text search runs against SQLite FTS5. It indexes both file names and content, supports match-case and regex toggles, and returns paginated results. The SQLite database is a materialized view of the CRDT state, rebuilt from Yjs updates whenever needed.

## Running locally

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
bun dev:opensidian
```

This starts the app dev server on port 5176 alongside the local API on `localhost:8787`, which auth and sync expect. `bun dev:opensidian:ui` runs the app without the API.

### Auth deployment

The public `opensidian.com` app uses OAuth app auth because relay sync needs a
bearer-capable `SyncAuthClient`. A reverse proxy for `/auth/*` can make hosted
sign-in same-origin, but it does not replace OAuth app auth unless the sync
relay also grows a cookie-authenticated path.

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework
- [Yjs](https://yjs.dev): CRDT engine (Y.Doc, Y.Array, Y.Map, Y.Text)
- [CodeMirror 6](https://codemirror.net): editor, with `y-codemirror.next` for Yjs binding
- [just-bash](https://github.com/nicolo-ribaudo/just-bash): bash interpreter in TypeScript
- [Better Auth](https://better-auth.com): authentication
- [Tailwind CSS](https://tailwindcss.com): styling
- [Cloudflare Workers + Durable Objects](https://developers.cloudflare.com/durable-objects/): sync server
- `@epicenter/workspace`: CRDT-backed tables, versioning, sync
- `@epicenter/filesystem`: POSIX filesystem layer over Yjs

---

## License

[AGPL-3.0](./LICENSE)
