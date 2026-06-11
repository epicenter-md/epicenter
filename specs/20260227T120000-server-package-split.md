# Server Package Split

**Date**: 2026-02-27
**Status**: Implemented
**Author**: AI-assisted

## Overview

Split `@epicenter/server` into three packages: a shared plugin library, a remote server package, and a local server package. Each gets its own `package.json`, its own dependency tree, and a clear single responsibility.

**Why now**: The remote and local servers have completely different dependency profiles (Better Auth + AI adapters vs workspace CRUD), different deployment targets (always-on server vs device sidecar), and different release cadences. Jamming them into one package means every consumer pays for dependencies they don't use, and changes to remote auth force version bumps on the local server for no reason.

## Naming Decision

**Packages**: `@epicenter/server`, `@epicenter/server-remote`, `@epicenter/server-local`

**Why `remote` / `local`**: The most universally understood pair in computing. "Remote" describes the relationship to the device, not the hosting provider: even when self-hosted on a Raspberry Pi, it's still remote relative to the laptops and phones connecting to it. The local server runs *on* your device. The remote server runs *somewhere else*.

**Why `server-` prefix**: Creates a visual family. When sorted alphabetically in a file tree or `package.json`, all three cluster together. `server-remote` and `server-local` are self-describing: they're servers, one's remote, one's local. The shared package `@epicenter/server` naturally reads as "the base server stuff" that the other two build on.

**Terminology update**: The canonical term changes from "hub server" to "remote server". `createHubServer()` becomes `createRemoteServer()`. All specs, code, and docs should use "remote server" going forward.

## Current State

Everything lives in `packages/server/` as `@epicenter/server`:

```
packages/server/
├── package.json          ← One package, all deps
├── src/
│   ├── index.ts          ← Exports everything
│   ├── hub.ts            ← createHubServer()
│   ├── local.ts          ← createLocalServer()
│   ├── start-hub.ts      ← Entry point
│   ├── start-local.ts    ← Entry point
│   ├── server.ts         ← Shared: listenWithFallback, DEFAULT_PORT
│   ├── sync/             ← Shared: Yjs WebSocket relay plugin
│   ├── workspace/        ← Local only: CRUD plugin
│   ├── auth/             ← Hub: Better Auth plugin + Local: session validator
│   ├── ai/               ← Hub only: AI streaming
│   ├── proxy/            ← Hub only: AI provider proxy
│   ├── discovery/        ← Shared: device discovery
│   └── opencode/         ← Local only: OpenCode process manager
```

**Consumers today:**
- `packages/cli/` imports `createLocalServer` (for `epicenter run`)
- `apps/epicenter/` (Tauri) starts the local server as a sidecar
- `start-hub.ts` / `start-local.ts` are dev entry points

## Desired State

Three packages, all in `packages/`:

```
packages/
├── server/               ← @epicenter/server (shared Elysia plugins)
├── server-remote/        ← @epicenter/server-remote (remote server composition)
└── server-local/         ← @epicenter/server-local (local server composition)
```

### Why `packages/`, Not `apps/`

In this monorepo, `apps/` contains things with their own build toolchain and UI: Tauri apps (Vite + SvelteKit), Astro sites, Chrome extensions (WXT). The remote and local servers are Elysia compositions. They export factory functions (`createRemoteServer`, `createLocalServer`) that other packages import. They're libraries first, entry points second. The CLI imports `createLocalServer` programmatically. The Tauri app will spawn the local server as a sidecar. These are library consumers, not standalone apps.

The thin `start.ts` entry points are dev conveniences, not the primary interface. They stay inside each package as scripts.

## Package Design

### `@epicenter/server`: Shared Plugins

The foundation. Elysia plugins and utilities that both remote and local servers compose from. No server composition of its own, just the building blocks.

```
packages/server/
├── package.json
└── src/
    ├── index.ts              ← Re-exports all plugins
    ├── server.ts             ← listenWithFallback, DEFAULT_PORT
    ├── sync/
    │   ├── plugin.ts         ← createSyncPlugin()
    │   ├── protocol.ts       ← y-websocket message encoding
    │   ├── auth.ts           ← AuthConfig type + token validation
    │   ├── rooms.ts          ← Room manager + eviction
    │   └── index.ts
    └── discovery/
        ├── index.ts          ← createClientPresence, getDiscoveredDevices
        └── awareness.ts
```

**Exports:**
```typescript
// @epicenter/server
export { createSyncPlugin, type SyncPluginConfig } from './sync';
export { type AuthConfig } from './sync/auth';
export { listenWithFallback, DEFAULT_PORT } from './server';

// @epicenter/server/sync
export { createSyncPlugin, ... } from './sync';

// @epicenter/server/discovery
export { createClientPresence, getDiscoveredDevices, ... } from './discovery';
```

**Dependencies** (minimal):
```json
{
  "dependencies": {
    "elysia": "^1.2.25",
    "lib0": "catalog:",
    "y-protocols": "catalog:"
  },
  "peerDependencies": {
    "yjs": "catalog:"
  }
}
```

No Better Auth, no AI adapters, no workspace types. Just Elysia + Yjs.

### `@epicenter/server-remote`: Remote Server

Always-on coordination server: auth, AI, Yjs relay. Zero workspace knowledge. Self-hostable: runs in the cloud or on any always-on machine.

```
packages/server-remote/
├── package.json
├── src/
│   ├── index.ts              ← createRemoteServer, re-exports
│   ├── remote.ts             ← createRemoteServer()
│   ├── start.ts              ← Dev entry point
│   ├── auth/
│   │   ├── plugin.ts         ← createAuthPlugin() (Better Auth)
│   │   └── index.ts
│   ├── ai/
│   │   ├── plugin.ts         ← createAIPlugin() (SSE streaming)
│   │   ├── adapters.ts       ← Provider adapters
│   │   └── index.ts
│   └── proxy/
│       ├── plugin.ts         ← createProxyPlugin()
│       └── index.ts
```

**Exports:**
```typescript
// @epicenter/server-remote
export { createRemoteServer, type RemoteServerConfig } from './remote';
export { createAuthPlugin, createBetterAuth, type AuthPluginConfig } from './auth';

// @epicenter/server-remote/ai
export { createAIPlugin, createAdapter, SUPPORTED_PROVIDERS } from './ai';

// @epicenter/server-remote/proxy
export { createProxyPlugin } from './proxy';
```

**Dependencies:**
```json
{
  "dependencies": {
    "@epicenter/server": "workspace:*",
    "@elysiajs/openapi": "^1.4.11",
    "@tanstack/ai": "^0.5.1",
    "@tanstack/ai-anthropic": "^0.5.0",
    "@tanstack/ai-gemini": "^0.5.0",
    "@tanstack/ai-grok": "^0.5.0",
    "@tanstack/ai-openai": "^0.5.0",
    "better-auth": "^1.4.19",
    "elysia": "^1.2.25"
  }
}
```

**Scripts:**
```json
{
  "scripts": {
    "dev": "bun src/start.ts",
    "start": "bun src/start.ts"
  }
}
```

### `@epicenter/server-local`: Local Server

Per-device sidecar: workspace CRUD, persisted Y.Docs, extensions, actions.

```
packages/server-local/
├── package.json
├── src/
│   ├── index.ts              ← createLocalServer, re-exports
│   ├── local.ts              ← createLocalServer()
│   ├── start.ts              ← Dev entry point
│   ├── auth/
│   │   ├── local-auth.ts     ← createRemoteSessionValidator()
│   │   └── index.ts
│   ├── workspace/
│   │   ├── plugin.ts         ← createWorkspacePlugin()
│   │   ├── tables.ts
│   │   ├── kv.ts
│   │   ├── actions.ts
│   │   └── index.ts
│   └── opencode/
│       └── index.ts          ← createOpenCodeProcess()
```

**Exports:**
```typescript
// @epicenter/server-local
export { createLocalServer, type LocalServerConfig, type LocalApp } from './local';
export { createWorkspacePlugin } from './workspace';
export { createRemoteSessionValidator } from './auth/local-auth';

// @epicenter/server-local/workspace
export { createWorkspacePlugin, collectActionPaths, createKvPlugin } from './workspace';

// @epicenter/server-local/opencode
export { createOpenCodeProcess, ... } from './opencode';
```

**Dependencies:**
```json
{
  "dependencies": {
    "@epicenter/server": "workspace:*",
    "@elysiajs/cors": "^1.4.1",
    "@elysiajs/openapi": "^1.4.11",
    "elysia": "^1.2.25",
    "typebox": "catalog:",
    "wellcrafted": "catalog:"
  },
  "peerDependencies": {
    "@epicenter/workspace": "workspace:*",
    "yjs": "catalog:"
  }
}
```

**Scripts:**
```json
{
  "scripts": {
    "dev": "bun src/start.ts",
    "start": "bun src/start.ts"
  }
}
```

## Consumer Migration

### CLI (`packages/cli/`)

```diff
-import { createLocalServer } from '@epicenter/server';
+import { createLocalServer } from '@epicenter/server-local';
```

### Tauri sidecar (`apps/epicenter/`)

```diff
-import { createLocalServer } from '@epicenter/server';
+import { createLocalServer } from '@epicenter/server-local';
```

### Any remote server consumer

```diff
-import { createHubServer } from '@epicenter/server';
+import { createRemoteServer } from '@epicenter/server-remote';
```

### Shared plugin consumers

```diff
-import { createSyncPlugin } from '@epicenter/server/sync';
+import { createSyncPlugin } from '@epicenter/server/sync';
// unchanged: @epicenter/server still owns this
```

## `auth/` Split Detail

The current `auth/` directory contains two unrelated things:

| File | What it does | Goes to |
|---|---|---|
| `plugin.ts` | Better Auth setup, session management, SQLite-backed | `@epicenter/server-remote` |
| `local-auth.ts` | Validates Bearer tokens against remote server's `/auth/get-session` | `@epicenter/server-local` |

These have zero shared code. `plugin.ts` imports `better-auth`. `local-auth.ts` makes a `fetch` call. Clean split, no shared auth module needed.

## `keys/` Decision

The `keys/` subpath export (`@epicenter/server/keys`) needs investigation during implementation. If it's remote-only (API key management), it moves to `@epicenter/server-remote/keys`. If shared, stays in `@epicenter/server/keys`.

## Implementation Steps

1. Create `packages/server-remote/` and `packages/server-local/` directories with `package.json` files
2. Move remote-specific code (`hub.ts` → `remote.ts`, `auth/plugin.ts`, `ai/`, `proxy/`, `start-hub.ts` → `start.ts`) to `packages/server-remote/src/`
3. Move local-specific code (`local.ts`, `auth/local-auth.ts`, `workspace/`, `opencode/`, `start-local.ts` → `start.ts`) to `packages/server-local/src/`
4. Keep shared code (`sync/`, `discovery/`, `server.ts`) in `packages/server/src/`
5. Strip `packages/server/package.json` down to shared deps only (remove Better Auth, AI adapters, workspace)
6. Rename `createHubServer` → `createRemoteServer`, `HubServerConfig` → `RemoteServerConfig`, `createHubSessionValidator` → `createRemoteSessionValidator`
7. Update all `index.ts` exports in all three packages
8. Update CLI and Tauri app imports
9. Update monorepo workspace config (`bun-workspace` or root `package.json`)
10. Run `bun install` to rewire workspace dependencies
11. Verify `bun run typecheck` passes across all packages
12. Verify `bun test` passes

## Open Questions

### 1. Where Does `discovery/` Live?

Currently in `packages/server/src/discovery/`. It provides device presence awareness via Yjs. Both remote and local could theoretically use it, but today it's mainly used by the local server and the Tauri app.

Options:
- Keep in `@epicenter/server` (shared): safe default
- Move to `@epicenter/server-local`: if only local uses it
- Separate package `@epicenter/discovery`: if it grows

### 2. Should the Remote Server Have a Standalone Deploy Story?

Right now `start-hub.ts` is a 40-line dev script. Should `@epicenter/server-remote` also ship a Dockerfile or deploy config? Not blocking for the split, but worth considering the trajectory.

### 3. Deprecation Period or Hard Cut?

Options:
- **Hard cut**: Delete old exports from `@epicenter/server`, update all consumers in one PR. Clean.
- **Soft cut**: Keep re-exports in `@epicenter/server` that point to new packages with `@deprecated` JSDoc. Remove after one release cycle.

Since this is a monorepo with workspace dependencies and the consumer list is small (CLI + Tauri app), a hard cut in one PR seems right.
