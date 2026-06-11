# Positioning

Canonical messaging for Epicenter. Every public surface should derive from this document: README, landing page, package descriptions, social posts.

## One-Liner

**Local-first apps, one shared workspace.** Your notes, transcripts, and chat histories live in one folder of plain text and SQLite. Every app reads and writes to the same place.

For developers: a CRDT-powered workspace engine that materializes to SQLite and markdown, with typed schemas and multi-device sync. Not another note app: the infrastructure that apps share.

*"PKM substrate" is accurate but too niche for a tagline. Use it in developer-facing contexts (blog posts, technical talks) but not in the README or landing page hero.*

## The Hook

Most tools store your data in their own silo. Epicenter stores it in one folder on your machine: plain text and SQLite. Every app reads from the same place. Your transcripts inform your notes. Your notes guide your AI. Nothing gets copy-pasted between apps because there's nothing to copy-paste.

Under the hood, Yjs CRDTs are the single source of truth. They materialize *down* to SQLite (for fast queries) and markdown (for human-readable files). Sync happens over the Yjs protocol. The server is a relay, not an authority. It never sees your content if you encrypt it.

## What Epicenter Is

- An **ecosystem of open-source, local-first apps** that share one workspace
- A **TypeScript library** (`@epicenter/workspace`) for building CRDT-backed apps with typed schemas
- A **CLI** (`epicenter`) for inspecting, querying, and automating your workspace from the terminal
- A **sync server** (AGPL, self-hostable) that relays encrypted CRDT updates between devices

## What Epicenter Is Not

- Not a single app (it's a platform multiple apps share)
- Not cloud-first (local-first by default, sync is optional)
- Not a Notion/Obsidian clone (it's the layer beneath apps like those)

## Core Claims (Verifiable)

Every claim we make publicly should be provable by inspecting the repo:

| Claim | Proof |
|---|---|
| "Plain text and SQLite" | Markdown materializer writes `.md` files with YAML frontmatter. SQLite persistence stores Yjs updates. |
| "One folder" | All workspace data lives under a single directory per user. |
| "CRDT-powered sync" | Yjs `Y.Doc` is source of truth; sync uses the Yjs protocol over WebSocket. |
| "Encrypted at the CRDT level" | `XChaCha20-Poly1305` via `@noble/ciphers`; HKDF-SHA256 key derivation. Row values encrypted before sync. |
| "Self-hostable" | Sync server is open source under AGPL. Run it on your infrastructure, control the encryption keys. |
| "Bring your own model" | AI features use user-provided API keys. No middleman, no proxy required. |

## Competitor Positioning

### vs Obsidian
> Obsidian is a markdown editor with sync. Epicenter is the offline-first storage substrate where multiple apps share the same CRDT-backed data.

- **Win**: Shared memory across apps, not per-plugin storage. CRDT sync instead of file-level conflict resolution.
- **Lose**: Obsidian's plugin ecosystem and years of UX polish. We're earlier.

### vs Anytype
> Anytype is a purpose-built encrypted space ecosystem. Epicenter is the Yjs-backed substrate that lets many apps share the same schema and data.

- **Win**: Standard CRDT stack (Yjs, widely adopted and battle-tested) vs custom protocol. Developer-facing API with typed schemas, not just an end-user app.
- **Lose**: Anytype's product is more complete today. Their P2P sync story is more mature.

### vs Logseq
> Logseq is an outliner-first app. Epicenter is the structured local-first storage engine that can power outline UIs without trapping data in a single app.

- **Win**: SQL + structured schemas. Shared memory across tools. Encryption.
- **Lose**: Logseq's block/journal UX is more native. Larger community.

### vs Standard Notes
> Standard Notes secures your notes. Epicenter secures a whole local-first workspace that multiple apps share, with CRDTs, schemas, and materialized exports.

- **Win**: Platform, not just "notes." Structured data with schemas. Materialized to files you can inspect.
- **Lose**: Standard Notes' encryption UX is simpler to communicate. They've earned trust over years.

### vs Notion
> Notion is where your knowledge lives. Epicenter is where your knowledge stays.

- **Win**: Offline-first, local-first, open source, no cloud lock-in.
- **Lose**: Notion's UX, templates, collaboration, and distribution are years ahead.

### vs Karpathy's "Second Brain" System
> Karpathy showed the architecture. Epicenter is the runtime.

- **Win**: CRDT sync across devices, typed schemas, encryption, CLI automation: everything raw folders can't do.
- **Lose**: Karpathy's system wins on simplicity. A folder of markdown files needs zero infrastructure.

### vs Jazz
> Jazz syncs slices of a shared database to everyone. Epicenter materializes one whole workspace into a folder that belongs to you.

The two stacks converged from opposite premises: typed tables, query subscriptions, local-first writes, collaborative text. The difference is scope. Jazz is a multi-user relational database with partial replication and row-level permissions. Epicenter is hyper-focused on personal apps, so a workspace is a full local replica, the unit of sharing is the folder, and we refuse partial sync, row permissions, and snapshotting on purpose. That refusal is what lets us build on Yjs and open standards instead of a custom sync engine. See [the long form](articles/20260531T160000-i-kept-reinventing-jazz-the-win-is-what-we-refuse.md).

- **Win**: One folder you own, plain text and SQLite you can grep without the app, built on standard Yjs rather than a private protocol. Less to learn because the scope is smaller.
- **Lose**: Jazz scales to large shared datasets and multi-user row-level access that Epicenter deliberately won't. For a synced multi-user app database, Jazz is the better tool and further along.

## Headlines and Hooks

### Hacker News
1. "A local-first PKM substrate: CRDT-powered tables that materialize to SQLite and markdown"
2. "Stop arguing about apps. Own a portable workspace that multiple tools share"
3. "CRDTs + plain files: offline-first notes without sync nightmares"

### Twitter/X
1. "Your notes shouldn't depend on a vendor. Here's the CRDT-based way to keep them in a folder"
2. "Markdown is the export. The real system is the CRDT state that powers conflict-free sync"
3. "Notion stores knowledge in the cloud. Epicenter stores it in your folder"

### Karpathy Angle (strongest entry point)
Karpathy's "second brain" post (41K bookmarks) describes: three folders of .md files + a schema file (CLAUDE.md) + AI organizes everything. Epicenter is the infrastructure version of that system, with the same philosophy (local files, AI organizes, no cloud lock-in), but with real sync, real schemas, real encryption, and a CLI that makes "compile the wiki" a single command.

## Keywords

### Use These
`local-first`, `CRDT`, `Yjs`, `offline-first`, `own your data`, `conflict-free sync`, `personal knowledge base`, `PKM`, `second brain`, `plain text`, `SQLite`, `markdown`, `self-hosted`, `open source`, `end-to-end encryption`, `multi-device sync`, `materialize`, `workspace`

### Avoid These
`AI-native`, `agentic`, `next-gen`, `revolutionary`, `redefine`, `game changer`, `Web3`, `metaverse`, buzzword-stacking ("CRDT-powered AI-first encrypted next-gen offline-first workspace": say less, prove more)

## Package Descriptions

Canonical descriptions for npm/GitHub discoverability:

| Package | Description |
|---|---|
| `@epicenter/workspace` | Local-first workspace engine. CRDT-powered tables that materialize to SQLite and markdown, with typed schemas and multi-device sync. |
| `@epicenter/cli` | CLI for Epicenter workspaces. Inspect tables, query data, run actions, and manage sync from the terminal. |
| `@epicenter/sync` | Yjs-based sync protocol for Epicenter. Handles CRDT document exchange, awareness, and RPC over WebSocket. |
| `@epicenter/vault` | Adapter and MCP layer for Epicenter. Schema migrations, codec pipelines, and data access patterns. |
| `@epicenter/filesystem` | Filesystem operations for Epicenter workspaces. Read, write, and watch plain text and markdown files. |
| `@epicenter/skills` | Skill definitions and loaders for Epicenter workspace actions. |
| `@epicenter/ui` | Shared UI components for Epicenter apps. Built with Svelte 5 and shadcn-svelte. |

## Keywords per Package

| Package | Keywords |
|---|---|
| `@epicenter/workspace` | `local-first`, `CRDT`, `Yjs`, `offline-first`, `SQLite`, `markdown`, `personal knowledge base`, `PKM`, `second brain`, `sync`, `workspace`, `typed schema` |
| `@epicenter/cli` | `local-first`, `CLI`, `workspace`, `CRDT`, `offline-first`, `PKM`, `terminal` |
| `@epicenter/sync` | `Yjs`, `CRDT`, `sync`, `WebSocket`, `offline-first`, `local-first`, `real-time` |
| `@epicenter/vault` | `local-first`, `schema`, `migrations`, `MCP`, `adapter`, `CRDT`, `markdown` |
