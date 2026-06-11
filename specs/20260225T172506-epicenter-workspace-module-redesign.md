> **Status: Superseded** by `20260313T063000-workspace-architecture-decisions.md`. Workspace module loading is now defined in the main architecture spec.

# Epicenter Workspace Module Redesign

**Date**: 2026-02-25
**Status**: Superseded
**Author**: AI-assisted
**Branch**: main

> **Topology note**: The Bun sidecar (local server, `createLocalServer`) handles workspace CRUD, extensions, actions, persisted Y.Docs, and local Yjs relay between the SPA and the server's Y.Doc. The hub server (`createHubServer`) is a separate cloud deployment that handles AI proxy/streaming, Better Auth (session issuance), and cross-device Yjs relay. AI requests (TanStack AI, chat) from the SPA go directly to the hub, not the sidecar. The architecture diagram below shows the sidecar's responsibilities only; the hub is a distinct service.

## Overview

Switch workspace definitions from JSON metadata plus hardcoded templates to single-file TypeScript modules that can be downloaded, executed in Bun, and introspected at runtime to drive UI and API behavior.

## Motivation

### Current State

Workspace display metadata is stored as JSON on disk, while schemas live in code and are selected from a static template registry.

```json
{
	"id": "epicenter.whispering",
	"name": "Whispering",
	"description": "",
	"icon": null
}
```

Epicenter desktop loads metadata from JSON and then selects a compiled-in template by ID. CLI already resolves `epicenter.config.ts` and imports it via Bun to obtain a workspace client.

This creates problems:

1. **Schema is not portable**: the runtime can only introspect templates that are compiled into the app.
2. **Templates are fixed**: the UI cannot load or inspect new workspaces without a code update.
3. **Two paradigms exist**: desktop uses JSON metadata plus templates, while CLI uses a TypeScript config file.

### Desired State

Each workspace is represented by a TypeScript module that exports a workspace definition or client. The runtime can download and execute this module, then call `describeWorkspace()` to get JSON Schema for UI rendering.

```ts
// workspace.ts
import { defineWorkspace, defineTable, defineKv } from '@epicenter/workspace';
import { type } from 'arktype';

export const metadata = {
	id: 'epicenter.whispering',
	name: 'Whispering',
	description: '',
	icon: null,
};

export default defineWorkspace({
	id: metadata.id,
	tables: {
		recordings: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
	},
	kv: {
		settings: defineKv(type({ theme: "'light' | 'dark'" })),
	},
});
```

## Research Findings

### Existing Epicenter Runtime Patterns

The workspace package already exposes `describeWorkspace()` to turn a workspace client into a JSON-serializable descriptor, and the CLI already imports `epicenter.config.ts` directly with Bun. This means the core mechanism for runtime introspection exists; it is just not wired into the desktop app or distribution flow.

### Elysia SPA Serving

Elysia’s static plugin supports an `indexHTML` option that serves `index.html` as a fallback for SPA routes. This fits the plan to host the Svelte SPA from the Bun sidecar without a separate web server.

### JSRepo as Distribution

jsrepo is a CLI focused on distributing code from registries and supports GitHub-backed registries. It can be used to fetch workspace modules as source and install them locally as part of a “workspace registry” pipeline.

### Bun Runtime Configuration

The Bun docs list supported environment variables that control runtime behavior. `BUN_BE_BUN` is not documented there, so we should treat it as unverified until proven in source or docs.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Workspace source format | Single TypeScript module | Unifies desktop and CLI behavior and enables runtime introspection with existing APIs. |
| UI schema generation | `describeWorkspace()` on a live client | Already produces JSON Schema and action descriptors. No new schema pipeline needed. |
| Distribution | Registry-backed source download | Avoids bundling every workspace into the desktop app. |
| Server hosting | Bun sidecar with Elysia static plugin | Local-first, same-origin fetch, reuses existing server package. |
| Dependency install | Deferred and cached | Avoid repeated installs and reduce startup latency. |

## Architecture

The diagram shows the new flow from registry source to UI and local API. This covers only the sidecar tier. AI streaming and auth issuance are handled by the hub server (`createHubServer`), a separate cloud deployment: see the topology note at the top.

```
Registry Source
  └── workspace.ts (and dependencies)
        │
        ▼
Bun Sidecar (Elysia, createLocalServer)       Hub Server (createHubServer, cloud)
  ├── Module Loader (import workspace.ts)      ├── Better Auth (/auth/*)
  ├── Workspace Client (createWorkspace)       ├── AI streaming (/ai/chat, SSE)
  ├── Introspection (describeWorkspace)        ├── AI key proxy (/proxy/*)
  ├── REST + WS API (workspace plugin)         └── Yjs relay (/rooms/*, ephemeral,
  ├── Persisted Y.Docs (workspace.yjs)               cross-device)
  ├── Local Yjs relay (/rooms/*, SPA↔sidecar)
  └── Static SPA (Elysia static plugin)
        │                                            ▲
        ▼                                            │ AI requests
Tauri Webview ───────────────────────────────────────┘
  ├── UI uses schema descriptor for dynamic rendering
  ├── UI calls same-origin sidecar API routes
  └── UI calls hub for AI chat (different origin)
```

## Implementation Plan

### Phase 1: Loader and Descriptor Path

- [ ] **1.1** Define a workspace module contract (`metadata`, default export) and validate it at load time.
- [ ] **1.2** Build a Bun loader that can import a workspace module from a local path and return a workspace client.
- [ ] **1.3** Add a descriptor endpoint in the local server that returns `describeWorkspace(client)`.

### Phase 2: Distribution and Caching

- [ ] **2.1** Implement a local registry cache directory layout.
- [ ] **2.2** Add a fetch step that downloads workspace sources from a registry into the cache.
- [ ] **2.3** Add integrity checks and lockfile support for deterministic installs.

### Phase 3: Desktop Integration

- [ ] **3.1** Replace template registry usage in the desktop app with workspace module loading.
- [ ] **3.2** Replace definition.json metadata storage with metadata exported from the module or a small derived manifest.
- [ ] **3.3** Wire UI rendering to the descriptor endpoint for dynamic table and action forms.

### Phase 4: Migration and Compatibility

- [ ] **4.1** Provide a migration path for existing template-based workspaces.
- [ ] **4.2** Keep legacy JSON metadata reader behind a feature flag for one release.

## Edge Cases

### Untrusted Workspace Code

1. User installs a workspace module from a third-party registry.
2. The module has side effects on import.
3. The loader must run in a constrained environment or require explicit user trust.

### Dependency Drift

1. A workspace module relies on a new version of a dependency.
2. The local cache still has an older version.
3. The loader needs a lockfile or version pin to avoid silent mismatches.

### UI Schema Mismatch

1. Workspace code evolves and changes schema.
2. Cached UI schema is stale.
3. The UI must invalidate cached descriptors when module hashes change.

## Open Questions

1. How strict should the workspace module contract be.
Options: (a) default export must be a client, (b) default export must be a definition, (c) allow both with runtime detection.
Recommendation: allow both with strict runtime validation for now; refine later.

2. How do we safely execute third-party workspace modules.
Options: (a) trust on first use, (b) run in a separate Bun process with a limited API surface, (c) require signed registries only.
Recommendation: start with explicit trust on install plus clear warnings. Revisit process isolation for production.

3. What is “Svaltic” in the SPA hosting plan.
Context: I could not find references in the repo or docs. It may be a mis-typed library name.
Recommendation: clarify the intended tool or library before implementation.

## Success Criteria

- [ ] A workspace module can be loaded from a local path and instantiated in Bun.
- [ ] The server exposes a descriptor endpoint for UI introspection.
- [ ] The desktop app can render a workspace UI purely from the descriptor output.
- [ ] The Bun sidecar serves the SPA with a fallback route for client-side navigation.

## References

- `apps/epicenter/src/lib/workspaces/dynamic/service.ts` - JSON metadata CRUD today
- `apps/epicenter/src/lib/yjs/README.md` - current on-disk layout and template registry
- `packages/epicenter/src/workspace/describe-workspace.ts` - introspection output
- `packages/cli/src/discovery.ts` - Bun module import for `epicenter.config.ts`
- `packages/server/src/local.ts` - local server composition (Elysia)
- `packages/server/src/workspace/plugin.ts` - table + action routing
- `docs/articles/tauri-bun-dual-backend-architecture.md` - Bun sidecar pattern

## Review

Draft spec only. No code changes yet.
