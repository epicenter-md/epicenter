# Epicenter API Consumer Guide + README Update

## Goal

Two deliverables:
1. **`docs/guides/consuming-epicenter-api.md`**: A machine-readable guide for AI agents (and humans) explaining how to connect an app to the hosted Epicenter hub at `https://api.epicenter.so`.
2. **`packages/workspace/README.md` update**: Fix outdated API surface descriptions. The current README references a `createClient(id).withDefinition(def)` pattern with old column types (`id()`, `text()`, `boolean()`) that no longer exist. The actual API uses `createWorkspace(definition)` with `defineTable(type({...}))` via arktype.

## Context

The tab-manager (`apps/tab-manager/`) is the canonical consumer of the hosted API. Its `workspace.ts` and `auth.svelte.ts` are the reference implementations.

### What the hosted API exposes (from `apps/api/src/app.ts`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | No | Health check |
| GET/POST | `/auth/*` | No | Better Auth (sign-in, sign-up, OAuth, session) |
| GET | `/.well-known/openid-configuration/auth` | No | OpenID Connect discovery |
| GET | `/.well-known/oauth-authorization-server/auth` | No | OAuth server metadata |
| POST | `/ai/chat` | Yes | Stream AI chat completions (SSE) |
| GET | `/workspaces/:workspace` | Yes | Get workspace doc (HTTP) or upgrade to WebSocket |
| POST | `/workspaces/:workspace` | Yes | HTTP sync (send update, receive diff) |
| GET | `/documents/:document` | Yes | Get document doc (HTTP) or upgrade to WebSocket |
| POST | `/documents/:document` | Yes | HTTP sync for documents |
| POST | `/documents/:document/snapshots` | Yes | Save document snapshot |
| GET | `/documents/:document/snapshots` | Yes | List document snapshots |
| GET | `/documents/:document/snapshots/:id` | Yes | Get specific snapshot |
| DELETE | `/documents/:document/snapshots/:id` | Yes | Delete snapshot |

### Write-up accuracy issues found

1. **`plugins: [bearer()]` in client auth**: The actual client uses `fetchOptions.auth` pattern, not a `bearer()` plugin. Fix in guide.
2. **`client.extensions.sync.reconnect()` on sign-out**: Not present in actual code. The sign-out just deactivates encryption + clears state. Fix in guide.
3. **Missing `/documents/` endpoints**: The write-up only covers workspaces. Guide should mention documents.
4. **Missing AI endpoint**: `/ai/chat` not mentioned. Guide should at least note its existence.
5. **`packages/workspace/README.md` API mismatch**: Old `createClient` builder vs actual `createWorkspace`. Must fix.

## Plan

### Deliverable 1: Consumer Guide (`docs/guides/consuming-epicenter-api.md`)

Structure (machine-readable, agent-friendly):

1. **Overview**: What the hosted hub is, URL (`https://api.epicenter.so`), what it handles (auth, sync, AI, encryption keys)
2. **Prerequisites**: Packages needed (`@epicenter/workspace`, `better-auth/client`, `@epicenter/workspace/extensions/sync`, etc.)
3. **Step 1: Define your workspace**: `defineWorkspace` + `defineTable` with arktype types. Show real pattern from tab-manager.
4. **Step 2: Set up auth**: `createAuthClient` pointing at the hub. Show exact pattern from `auth.svelte.ts` (no `plugins: [bearer()]`). Include session type with `CustomSessionFields`.
5. **Step 3: Build the workspace client**: Full `createWorkspace(def).withEncryption().withExtension()` chain. Show each extension: persistence (indexeddb), broadcast (cross-tab), sync (WebSocket to hub).
6. **Step 4: Activate encryption after login**: Get session → `activateEncryption(base64ToBytes(encryptionKey))`. Show the actual `refreshEncryptionKey` pattern.
7. **Step 5: Sign-out cleanup**: `deactivateEncryption()` → `signOut()` → clear state. No `reconnect()`.
8. **API Reference**: Route table (from above). Note WebSocket upgrade behavior. Note Bearer token pattern (header for HTTP, query param for WS).
9. **Encryption model**: Brief: server-managed keys, HKDF-SHA256, per-user derivation. Link to existing articles.
10. **Self-hosting note**: Point at `apps/api/README.md` for deployment details.

### Deliverable 2: Workspace README Update

Targeted fixes (not a full rewrite. The README is 1700+ lines):

- [x] Fix "Quick Start" section: Replace `createClient(id).withDefinition(def)` with `createWorkspace(def)`. Replace old column types (`id()`, `text()`, etc.) with `defineTable(type({...}))`.
- [x] Fix "How It All Fits Together" section step 2-3: `createClient` -> `createWorkspace`, remove `.withDefinition()`.
- [x] Fix "Core Concepts > Extensions" examples: Update to current builder chain.
- [x] Fix "Create Client" section: Replace with `createWorkspace` pattern.
- [x] Fix "Client Properties" section: Update to actual property names.
- [x] Add pointer to the new consumer guide for hosted API usage.
- [x] Leave the detailed API reference sections (column types, table operations, etc.) alone.

## Todos

- [x] Write `docs/guides/consuming-epicenter-api.md` with all 10 sections
- [x] Update `packages/workspace/README.md` Quick Start example
- [x] Update `packages/workspace/README.md` "How It All Fits Together" section
- [x] Update `packages/workspace/README.md` "Core Concepts > Extensions" examples
- [x] Update `packages/workspace/README.md` "Create Client" -> "Create Workspace"
- [x] Update `packages/workspace/README.md` "Client Properties" section
- [x] Add cross-reference to consumer guide in README
- [x] Verify no broken references or dead links

## Non-goals

- Full rewrite of the workspace README (too much effort, too much risk)
- Covering the local-only (non-hosted) server setup. That's already in `apps/api/README.md`
- Documenting the AI chat endpoint in detail. It's a separate concern
- Updating the top-level repo README

## Review

### Changes Made

Deliverable 1: Consumer Guide (`docs/guides/consuming-epicenter-api.md`)
- 228-line guide with 10 sections targeting AI agents
- All code examples verified against actual codebase (tab-manager as canonical reference)
- Corrected 5 inaccuracies from the original write-up:
  1. Removed `plugins: [bearer()]` (actual code uses `fetchOptions.auth`)
  2. Removed `client.extensions.sync.reconnect()` from sign-out (doesn't exist)
  3. Added `/documents/` endpoints and snapshot API
  4. Added `/ai/chat` endpoint
  5. Fixed auth client pattern to match `auth.svelte.ts`

Deliverable 2: Workspace README Update (`packages/workspace/README.md`)
- Eliminated all 38 occurrences of `createClient`/`.withDefinition`
- Replaced with `createWorkspace(definition)` pattern throughout
- Updated Quick Start to use `defineTable(type({...}))` via arktype
- Collapsed "How It All Fits Together" steps 2-3 into single step, renumbered
- Renamed "Create Client" section to "Create Workspace"
- Added cross-reference to consumer guide at top of file
- Left column types reference, table operations, and MCP sections untouched
