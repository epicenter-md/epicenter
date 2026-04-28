[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/epicenterhq-epicenter-badge.png)](https://mseep.ai/app/epicenterhq-epicenter)

<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center">Local-first, open-source apps</p>
  <p align="center">One folder of plain text and SQLite on your machine, synced across all your devices.<br>Grep it, query it, host it wherever you want.</p>
</p>

<p align="center">
  <!-- GitHub Stars Badge -->
  <a href="https://github.com/EpicenterHQ/epicenter" target="_blank">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/EpicenterHQ/epicenter?style=flat-square" />
  </a>
  <!-- Latest Version Badge -->
  <img src="https://img.shields.io/github/v/release/EpicenterHQ/epicenter?style=flat-square&label=Latest%20Version&color=brightgreen" />
  <!-- License Badge -->
  <a href="LICENSE" target="_blank">
    <img alt="License" src="https://img.shields.io/github/license/EpicenterHQ/epicenter.svg?style=flat-square" />
  </a>
  <!-- Discord Badge -->
  <a href="https://go.epicenter.so/discord" target="_blank">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" />
  </a>
  <!-- Platform Support Badges -->
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="macOS" src="https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
  </a>
</p>

<p align="center">
  <a href="#apps">Apps</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#packages">Packages</a> •
  <a href="#for-developers">For Developers</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#contributing">Contributing</a> •
  <a href="https://go.epicenter.so/discord">Discord</a>
</p>

---

## What is Epicenter?

Epicenter is an ecosystem of open-source, local-first apps. All your data—notes, transcripts, chat histories—lives in a single folder of plain text and SQLite on your machine. Every tool we build reads and writes to the same place. It's open, tweakable, and yours. Grep it, open it in Obsidian, version it with Git, host it wherever you want.

Under the hood, Yjs CRDTs are the single source of truth. They materialize *down* to SQLite (for fast queries) and markdown (for human-readable files). Sync happens over the Yjs protocol; the server is a relay, not an authority—it never sees your content.

The library that powers this, [`@epicenter/workspace`](packages/workspace), is something other developers can build on too. Define a typed schema, get CRDT-backed tables with multi-device sync handled for you.

## Architecture

```
                              ┌──────────────────────────────────┐
                              │         @epicenter/api           │
                              │   Cloudflare Workers + DO hub    │
                              │   auth · sync relay · AI chat    │
                              └──────────┬───────────────────────┘
                                         │ y-websocket protocol
                    ┌────────────────────┼──────────────────────┐
                    │                    │                      │
               ┌────▼──────┐      ┌─────▼───────┐      ┌──────▼──────┐
               │ Whispering│      │  Opensidian  │      │ Tab Manager │
               │  (Tauri)  │      │ (SvelteKit)  │      │  (WXT ext)  │
               └────┬──────┘      └─────┬────────┘      └──────┬──────┘
                    │                    │                      │
          ┌─────────┴────────────────────┴──────────────────────┘
          │              All apps share these layers:
          │
    ┌─────▼───────────────────────────────────────────────────────────┐
    │                     MIDDLEWARE / ADAPTERS                        │
    │  @epicenter/svelte    — Svelte integration, auth, persistence   │
    │  @epicenter/filesystem — POSIX file layer over Yjs              │
    │  @epicenter/skills    — skill/reference tables                  │
    │  @epicenter/ai        — LLM tool bridging                      │
    └─────────────────────────────┬───────────────────────────────────┘
                                  │
    ┌──────────────────────────────▼───────────────────────────────────┐
    │                           CORE                                   │
    │  @epicenter/workspace — typed schemas, Yjs CRDTs, extensions,   │
    │                         E2E encryption, lifecycle, materializers │
    │  @epicenter/sync      — protocol encoding/decoding, V2 updates  │
    │  @epicenter/constants — app URLs, versions, shared config       │
    │  @epicenter/ui        — shadcn-svelte component library         │
    │  @epicenter/cli       — TypeBox→yargs CLI, auth/session APIs    │
    └─────────────────────────────────────────────────────────────────┘
```

The dependency flow is strict: core has zero upward dependencies, middleware only reaches into core, and apps compose both. [`@epicenter/workspace`](packages/workspace) is the gravitational center—every middleware package and most apps depend on it. The sync server is a relay, not an authority; it never sees your content because encryption happens client-side before anything leaves the device.

[Full architecture walkthrough →](docs/architecture.md) · [Encryption design →](docs/encryption.md)

## Apps

<table>
  <tr>
    <td align="center" width="50%">
      <h3><a href="apps/whispering">Whispering</a></h3>
      <p>Press shortcut, speak, get text. Desktop transcription that cuts out the middleman. Bring your own API key or run locally with Whisper C++.</p>
      <p><strong><a href="apps/whispering">Source</a></strong> · <strong><a href="apps/whispering#install-whispering">Install</a></strong></p>
    </td>
    <td align="center" width="50%">
      <h3><a href="apps/opensidian">Opensidian</a></h3>
      <p>Local-first note-taking with a built-in bash terminal, end-to-end encryption, and real-time sync. Your notes live in a CRDT-backed virtual filesystem.</p>
      <p><strong><a href="apps/opensidian">Source</a></strong> · <strong><a href="https://opensidian.com">Try it</a></strong></p>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <h3><a href="apps/tab-manager">Tab Manager</a></h3>
      <p>Browser extension side panel for managing tabs with workspace sync and AI chat that can call workspace tools with inline approval.</p>
      <p><strong><a href="apps/tab-manager">Source</a></strong></p>
    </td>
    <td align="center" width="50%">
      <h3><a href="apps/honeycrisp">Honeycrisp</a></h3>
      <p>Apple Notes-style local-first notes app. Folders, rich-text editing with ProseMirror, and collaborative sync via Yjs.</p>
      <p><strong><a href="apps/honeycrisp">Source</a></strong></p>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <h3><a href="apps/api">Epicenter API</a></h3>
      <p>The hub server. Auth, real-time sync via Durable Objects, and AI inference. Everything that needs a single authority across devices.</p>
      <p><strong><a href="apps/api">Source</a></strong></p>
    </td>
    <td align="center" width="50%">
      <h3>Build your own</h3>
      <p>The <a href="packages/workspace"><code>@epicenter/workspace</code></a> library makes it straightforward to build apps that share the same CRDT-backed data. Define a schema, get tables, add sync.</p>
    </td>
  </tr>
</table>

Also in the repo: [Fuji](apps/fuji) (personal CMS), [Zhongwen](apps/zhongwen) (Mandarin learning chat), [Skills Editor](apps/skills) (agent skill manager), [Dashboard](apps/dashboard) (billing UI), and [Landing](apps/landing) (public site).

## Packages

| Package | Description | License |
| --- | --- | --- |
| [`@epicenter/workspace`](packages/workspace) | Core library. Typed schemas, Yjs CRDTs, extension builder, E2E encryption, materializers. Everything builds on this. | MIT |
| [`@epicenter/sync`](packages/sync) | Yjs sync protocol encoding/decoding. Dumb server, smart client—protocol framing is separate from transport. | AGPL-3.0 |
| [`@epicenter/ui`](packages/ui) | shadcn-svelte component library shared across all apps. | MIT |
| [`@epicenter/svelte`](packages/svelte-utils) | Svelte 5 integration—persisted state, auth, workspace gate, TanStack Query helpers. | MIT |
| [`@epicenter/filesystem`](packages/filesystem) | POSIX-style virtual filesystem over Yjs workspace tables. `mkdir`, `mv`, `rm`, `stat`. | MIT |
| [`@epicenter/skills`](packages/skills) | Skill and reference tables for AI-enhanced workspace apps. | MIT |
| [`@epicenter/ai`](packages/ai) | Bridges workspace actions with LLM tool calling. | MIT |
| [`@epicenter/cli`](packages/cli) | The `epicenter` command. TypeBox schemas become CLI flags automatically. | MIT |
| [`@epicenter/constants`](packages/constants) | Shared URLs, ports, and version info across the monorepo. | MIT |

## For Developers

The hard problem with local-first apps is synchronization. If each device has its own SQLite file, how do you keep them in sync? If each device has its own markdown folder, same question. We ended up using Yjs CRDTs as the single source of truth, then materializing that data *down* to SQLite (for fast SQL reads) and markdown (for human-readable files). Yjs handles the sync; SQLite and markdown handle the reads.

The [`@epicenter/workspace`](packages/workspace) package wraps this into a single API. Define a schema, get CRDT-backed tables, attach providers to materialize to SQLite or markdown, and add sync when you're ready.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
  attachIndexedDb,
  attachSync,
  attachTables,
  defineDocument,
  defineTable,
  toWsUrl,
} from '@epicenter/workspace';

const posts = defineTable(
  type({ id: 'string', title: 'string', published: 'boolean', _v: '1' }),
);

const blog = defineDocument((id: string) => {
  const ydoc = new Y.Doc({ guid: id });
  const tables = attachTables(ydoc, { posts });
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, {
    url: (docId) => toWsUrl(`http://localhost:3913/rooms/${docId}`),
    waitFor: idb.whenLoaded,
  });

  return {
    id, ydoc, tables, idb, sync,
    whenReady: idb.whenLoaded,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
});

const workspace = await blog.load('epicenter.blog');
workspace.tables.posts.set({ id: '1', title: 'Hello', published: false, _v: 1 });
```

Each user gets their own database. Schema definitions are plain JSON, so they work with MCP and OpenAPI out of the box. Write to Yjs and SQLite updates; edit a markdown file and the CRDT merges it in.

**[Read the full workspace docs →](packages/workspace/README.md)**

## Where We're Headed

More apps are in progress—each one shares the same workspace, so data flows between them without import/export. The [`@epicenter/workspace`](packages/workspace) library handles the hard parts (schemas, CRDT sync, materialization), so each new app is mostly UI.

Epicenter Cloud will provide hosted sync for people who don't want to run their own server. Same model as Supabase selling hosted Postgres or Liveblocks selling hosted collaboration. Self-hosting is and will remain first-class—the sync server is open source under AGPL, and when you run it yourself, you control the encryption keys and trust boundary.

## Quick Start

### Install Whispering

```bash
brew install --cask whispering
```

Or download directly from [GitHub Releases](https://github.com/EpicenterHQ/epicenter/releases/latest) for macOS (.dmg), Windows (.msi), or Linux (.AppImage, .deb, .rpm).

**[Full installation guide →](apps/whispering#install-whispering)**

### Build from Source

```bash
# Prerequisites: Bun (https://bun.sh) and Rust (https://rustup.rs)
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
cd apps/whispering
bun dev
```

### Troubleshooting

If things break after switching branches or pulling changes:

```bash
bun clean    # Clears caches and node_modules
bun install  # Reinstall dependencies
```

For a full reset including Rust build artifacts (~10GB, takes longer to rebuild):

```bash
bun nuke     # Clears everything including Rust target
bun install
```

You rarely need `bun nuke`—Cargo handles incremental builds well. Use `bun clean` first.

## Contributing

We're looking for contributors who are passionate about open source, local-first software, or just want to build with Svelte and TypeScript.

**[Read the Contributing Guide →](CONTRIBUTING.md)**

Contributors coordinate in our [Discord](https://go.epicenter.so/discord).

## Tech Stack

<p align="center">
  <img alt="Svelte 5" src="https://img.shields.io/badge/-Svelte%205-orange?style=flat-square&logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/-Tauri-blue?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/-TypeScript-blue?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/-Rust-orange?style=flat-square&logo=rust&logoColor=white" />
  <img alt="Yjs" src="https://img.shields.io/badge/-Yjs-green?style=flat-square" />
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" />
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/-Tailwind%20CSS-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white" />
</p>

## Design Decisions

We publish our implementation specs. These are the reasoning behind non-obvious architectural choices—alternatives considered, trade-offs made, and why we landed where we did.

| Spec | What it decided |
| --- | --- |
| [Encrypted Workspace Storage](specs/20260213T005300-encrypted-workspace-storage.md) | XChaCha20-Poly1305 at the CRDT value level; server-managed keys with self-hosting as the trust boundary |
| [Y-Sweet Persistence Architecture](specs/20260212T190000-y-sweet-persistence-architecture.md) | How Yjs documents persist and compact in Durable Objects |
| [Simple Definition-First Workspace API](specs/20260201T120000-simple-definition-first-workspace.md) | The `defineTable` → `defineDocument` + `attach*` composition pattern |
| [Resilient Client Architecture](specs/20260119T231252-resilient-client-architecture.md) | How workspace clients handle offline, reconnect, and extension failures |
| [Migrate to @epicenter/sync](specs/20260214T120800-migrate-y-sweet-to-epicenter-sync.md) | Custom sync protocol replacing Y-Sweet with our own framing layer |

All 112 implemented specs live in [`specs/`](specs/).

## License

Most packages and all apps are [MIT](licenses/LICENSE-MIT)—use them however you want, no strings attached. The sync server (`apps/api`) and sync protocol (`packages/sync`) are [AGPL-3.0](licenses/LICENSE-AGPL-3.0), which means anyone hosting a modified version shares their changes. This follows the same pattern as Yjs (MIT core, AGPL y-redis), Liveblocks (Apache clients, AGPL server), and Bitwarden (GPL clients, AGPL server).

See [FINANCIAL_SUSTAINABILITY.md](FINANCIAL_SUSTAINABILITY.md) for the full reasoning behind the split.

---

<p align="center">
  <strong>Contact:</strong> <a href="mailto:github@bradenwong.com">github@bradenwong.com</a> | <a href="https://go.epicenter.so/discord">Discord</a> | <a href="https://twitter.com/braden_wong_">@braden_wong_</a>
</p>

<p align="center">
  <sub>Local-first · CRDT · Own your data · Open source</sub>
</p>
