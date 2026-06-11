# Network Topology: Multi-Server Architecture

**Date**: 2026-02-22
**Status**: Draft (design discussion: not yet implementation-ready)
**Author**: Braden + AI-assisted
**Related**: `20260219T195800-server-architecture-rethink.md`, `20260220T080000-plugin-first-server-architecture.md`, `20260220T133004-unified-local-server-architecture.md`, `20260222T073156-unified-cli-server-sidecar.md`, `20260219T200000-deployment-targets-research.md`, `20260222T195800-server-side-api-key-management.md`, `20260121T170000-sync-architecture.md`, `20260109T140700-opencode-integration-architecture.md`

> **Path note (2026-05-22):** The local key-store references under `~/.epicenter/server/` are stale. Do not use this draft to recreate top-level home-directory server key storage.

## Overview

A three-tier network topology for Epicenter where every desktop runs a local Elysia.js server as a Tauri sidecar, one designated hub server coordinates all devices, and mobile clients connect through the hub. The hub server handles ALL AI streaming (cloud providers and Ollama alike) and acts as an AI proxy for local OpenCode instances. Each desktop runs an XDG-isolated OpenCode process for AI-powered coding agent capabilities, with provider requests routed through the hub's proxy (keys never leave hub). Local sidecars focus exclusively on sync relay and workspace operations. The hub is interchangeable: users can self-host it with a compiled binary or use Epicenter's cloud infrastructure. Both modes use Better Auth for authentication.

## Motivation

### Current State

The existing architecture assumes a single server topology:

```
Desktop App (Tauri)
  └── Bun sidecar (localhost:3913)
      ├── Sync relay (/rooms)
      ├── Workspace API (/workspaces)
      └── AI chat (/ai/chat)
```

The server package (`@epicenter/server`) exposes `createServer()` which composes sync, workspace, and AI plugins into a single Elysia app. Each desktop runs its own instance. There is no coordination between devices: sync happens through a shared relay (Y-Sweet or the server's own sync plugin), but there's no concept of a "hub" server or device discovery.

This creates problems:

1. **Mobile has no server**: Mobile devices can't run a Bun sidecar. They need a known, stable server URL to connect to for sync and AI. Currently there's no designated "always-on" endpoint for mobile to target.
2. **No device discovery**: Desktop A doesn't know Desktop B exists. Each sidecar operates independently. There's no awareness of which devices are online or what capabilities they have.
3. **API key isolation**: Each desktop's sidecar has its own key store (`~/.epicenter/server/keys.json`). Users must configure API keys separately on every machine. No single source of truth.
4. **No auth boundary on localhost**: Any website could potentially hit `localhost:3913`. The `20260222T200800-server-endpoint-security.md` spec addresses this with CORS + bearer tokens, but there's no central auth system tying it together.
5. **No path from self-hosted to cloud**: Users who start with a local setup have no migration path to a managed cloud service (or vice versa) without reconfiguring everything.

### Desired State

A topology where:

- Every desktop runs a sidecar (Tauri sidecar) for low-latency sync and workspace operations
- One hub server acts as the coordination hub, key store, AI endpoint, and mobile entry point
- ALL AI streaming (cloud providers and Ollama) goes through the hub server
- The hub is interchangeable between self-hosted binary and Epicenter's cloud
- Better Auth runs on the hub in both modes
- All devices connect to the hub for sync and AI
- Desktop sidecars provide fast local sync relay between the Tauri webview and the hub
- Devices discover each other through the hub's coordination layer

## Research Findings

### Prior Art in This Codebase

Several existing specs address pieces of this topology:

| Spec | What It Covers | Relationship to This Spec |
| --- | --- | --- |
| `plugin-first-server-architecture` | Composable Elysia plugins (sync, workspace, AI) | The building blocks for hub server composition |
| `unified-local-server-architecture` | Bun HTTP server as Tauri sidecar | How local desktop servers work today (to be slimmed down) |
| `unified-cli-server-sidecar` | Single compiled binary running the server | The self-hosted hub server binary |
| `deployment-targets-research` | Self-hosted Bun vs CF Workers + DOs | Cloud target for the hub server |
| `server-side-api-key-management` | Encrypted key store on server | Key storage on the hub server |
| `sync-architecture` | Three sync modes: local, self-hosted, cloud | How sync works across the topology |
| `server-endpoint-security` | CORS allowlist + bearer token for localhost | Auth boundary on sidecars |

The architecture is already designed in layers. The plugin-first approach means `createServer()` can be composed differently for the hub (full: sync + AI + auth + coordination) versus local sidecars (minimal: sync + workspace only). No fundamental redesign is needed; the topology is an orchestration layer on top of existing components.

### How Other Local-First Tools Handle Multi-Device

| Tool | Topology | Coordination | AI Location |
| --- | --- | --- | --- |
| Obsidian Sync | Client → Central server | Obsidian's cloud relay | N/A (no AI) |
| Linear | Client → Central server | Linear's cloud | Server-side |
| Figma | Client → Central server | Figma's cloud | Server-side |
| Jan.ai | Single device only | N/A | Local only |
| Open WebUI | Client → Self-hosted server | Single server | Server-side (proxied) |
| Tailscale | Mesh network (peer-to-peer) | Coordination server (control plane) | N/A |

Every multi-device collaboration tool uses a central coordination server. The variation is whether it's cloud-only (Linear, Figma), self-hosted (Open WebUI), or hybrid (Obsidian). Nobody does fully decentralized coordination for CRDT sync. There's always at least one "known" endpoint. Tailscale's model (lightweight control plane + direct peer connections) is the closest analog to what we're building.

A designated hub server is the standard pattern. The innovation here is making it interchangeable between self-hosted and cloud.

### AI Streaming Location Analysis

The original draft considered three options for AI routing: hub-only with a local Ollama exception, keys distributed to every sidecar, or a hybrid proxy model. All three created complexity because they split AI routing between two servers.

The simplest design is: **all AI on hub, no exceptions.** Here's why:

1. **TanStack AI is serverful by design.** The `chat()` function and `toServerSentEventsResponse()` run on a server. The client uses `useChat` / `ChatClient` with `fetchServerSentEvents()` to consume an SSE endpoint. The entire framework assumes `client → server → provider → SSE back`. Putting AI on the hub aligns perfectly with how TanStack AI is meant to be used.

2. **Ollama doesn't need a sidecar.** TanStack AI's Ollama adapter already supports configurable hosts: `createOllamaChat("http://host:port")`. The hub calls Ollama at whatever `OLLAMA_HOST` is configured. When the hub IS your desktop (self-hosted), Ollama is at `localhost:11434` with zero network hop. When the hub is a different machine, `OLLAMA_HOST` points to wherever Ollama is running on the LAN.

3. **One endpoint eliminates all client routing logic.** The client always calls `hubServerUrl/ai/chat`. No `if (provider === 'ollama')` branching. No provider-aware routing. No sidecar awareness. One line of code.

4. **Key management stays trivial.** Keys live on the hub in one encrypted store. No distribution, no sync, no encrypted Yjs KV. The `server-side-api-key-management` spec applies without changes.

5. **The extra network hop is irrelevant.** An LLM API call takes 500ms: 30s. A local-to-hub hop adds 5ms. Token arrival speed is identical because responses stream via SSE.

| Dimension | All AI on Hub |
| --- | --- |
| Client routing | `hubUrl + "/ai/chat"`: one endpoint, always |
| Key management | Keys on hub only. Zero distribution. |
| Ollama handling | Hub config: `OLLAMA_HOST`. Same AI plugin code. |
| Mobile support | Same endpoint as desktop. Nothing special. |
| TanStack AI fit | Used exactly as designed: serverful. |
| Local sidecar AI code | None. Deleted. |
| Fault tolerance | Hub down = no AI. Same as sync/auth being down. |

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Topology model | Three-tier (hub + local sidecars + clients) | Standard pattern. Hub provides coordination + AI, sidecars provide low-latency local sync. |
| Hub interchangeability | Self-hosted binary OR Epicenter cloud | Users aren't locked in. Same Better Auth, same API surface. Only the URL changes. |
| Auth system | Better Auth on hub (both modes) | One auth system everywhere. Session tokens work the same whether hub is localhost or cloud. |
| AI location | ALL on hub (cloud providers AND Ollama) | One endpoint. No client routing logic. Keys centralized. TanStack AI is serverful. |
| Ollama configuration | `OLLAMA_HOST` env var on hub | Hub calls Ollama at the configured host. Default `localhost:11434` for self-hosted. |
| Local sidecar role | Sync relay + workspace API only | Sidecars stripped of AI responsibility. Simpler, focused. |
| Mobile entry point | Hub server URL (configured once) | Mobile has no sidecar. Hub is the only stable endpoint. |
| Sidecar auth | Session token validated against hub | Prevents random websites from hitting localhost. Tauri webview gets whitelisted origin + valid session. |
| Server discovery | Yjs Awareness on a shared discovery room | Devices set presence via Awareness protocol on a shared coordination doc. Auto-cleanup on disconnect. No heartbeat/register endpoints needed. |
| Key storage | Hub server only (encrypted JSON or Postgres) | Single source of truth. No key distribution problem. Same `server-side-api-key-management` spec. |
| Hub URL configuration | Mode-based: built-in for cloud, manual for self-hosted | Cloud users get a hardcoded URL. Self-hosted users enter their URL once during onboarding. |
| OpenCode AI agent | Local process per desktop, providers proxied through hub | OpenCode needs local file access and local plugin execution. Provider API keys stay on hub via reverse proxy. |
| OpenCode key access | Hub as provider-compatible reverse proxy (baseURL rewrite) | Keys never leave hub. Session token is the only credential on each device. Proxy is a passthrough -- no request parsing needed. |
| OpenCode plugin execution | Always local, never on cloud hub | Desktop plugins need arbitrary code execution. Cloud hub (CF Workers) cannot run arbitrary code. Plugin lists sync via Yjs. |

## Architecture

### Three-Tier Topology

```
                 ┌─────────────────────────────────┐
                 │         Hub Server            │
                 │  (self-hosted binary OR          │
                 │   Epicenter cloud)               │
                 │                                  │
                 │  • Better Auth (login)           │
                 │  • API key store (encrypted)     │
                 │  • Sync relay (primary)          │
                 │  • AI streaming (/ai/chat)       │
                 │  • AI proxy (/proxy/{provider})  │
                 │    for OpenCode instances         │
                 │  • Server discovery (Awareness)  │
                 │  • Workspace API (optional)      │
                 └────────────────┬────────────────┘
                                │
                 ┌──────────────┼──────────────┐
                 │              │              │
            ┌────▼──────┐  ┌────▼──────┐  ┌────▼─────┐
            │Desktop A  │  │Desktop B  │  │ Mobile   │
            │ Tauri +   │  │ Tauri +   │  │ (client  │
            │ Bun       │  │ Bun       │  │  only)   │
            │ sidecar   │  │ sidecar   │  │          │
            │           │  │           │  │ No local │
            │ Sync +    │  │ Sync +    │  │ server   │
            │ Workspace │  │ Workspace │  │ No       │
            │ (no AI)   │  │ (no AI)   │  │ OpenCode │
            │           │  │           │  └──────────┘
            │ OpenCode  │  │ OpenCode  │
            │ (local AI │  │ (local AI │
            │  agent)   │  │  agent)   │
            │ providers │  │ providers │
            │ → proxy  │  │ → proxy  │
            │ to hub│  │ to hub│
            │           │  │           │
            │ Local MCP │  │ Local MCP │
            │ servers + │  │ servers + │
            │ plugins   │  │ plugins   │
            └───────────┘  └───────────┘
```

### Hub Server Composition

The hub server uses the `@epicenter/server` plugin system with the full composition:

```
Hub Server (createHubServer)
├── GET  /                                     ← Discovery
├── GET  /openapi                              ← Scalar UI docs
├── POST /auth/login                           ← Better Auth
├── POST /auth/signup                          ← Better Auth
├── GET  /auth/session                         ← Better Auth
├── WS   /rooms/{id}/sync                      ← Yjs WebSocket sync (primary relay)
├── POST /ai/chat                              ← AI streaming (ALL providers via SSE)
├── ALL  /proxy/{provider}/*                    ← AI proxy passthrough for OpenCode
├── PUT  /api/provider-keys/:provider           ← Key management
├── GET  /api/provider-keys                     ← List configured providers
├── DELETE /api/provider-keys/:provider         ← Remove key
└── /workspaces/...                             ← Optional workspace CRUD

Note: Server discovery uses Yjs Awareness on the sync layer, not REST endpoints.
Devices connect to a shared discovery room (WS /rooms/_epicenter_discovery/sync)
and broadcast presence via awareness.setLocalState(). No dedicated discovery
endpoints needed.
```

The AI plugin on hub handles every provider identically. For cloud providers it resolves the API key from the encrypted store. For Ollama it calls the host at `OLLAMA_HOST` (no key needed). Same `createAIPlugin()`, same `resolveApiKey()` chain, same `chat()` + `toServerSentEventsResponse()`.

### Sidecar Composition (Tauri Sidecar)

The sidecar is a minimal composition focused on sync and workspace:

```
Sidecar (createSidecarServer)
├── GET  /                                     ← Discovery / health check
├── WS   /rooms/{id}/sync                      ← Yjs WebSocket sync (local relay)
├── /workspaces/...                             ← Workspace CRUD (local)
└── (NO auth endpoints, NO AI, NO key management,
     NO server discovery: discovery uses Awareness on hub's sync layer)
```

The sidecar has zero AI responsibility. It exists to provide fast local sync between the Tauri webview and Y.Doc persistence, and to serve the workspace API for local file operations.

### Sync Topology

The hub is the primary sync relay. All devices ultimately sync through it:

```
┌─────────────────────────────────────────────────────────────────┐
│                        SYNC TOPOLOGY                           │
│                                                                │
│                    ┌──────────────┐                             │
│                    │ Hub Server│                             │
│                    │  (primary    │                             │
│                    │   relay)     │                             │
│                    └──────┬───────┘                             │
│                           │                                    │
│              ┌────────────┼────────────┐                       │
│              │            │            │                        │
│        ┌─────▼─────┐ ┌───▼──────┐ ┌──▼───────┐               │
│        │ Sidecar A │ │Sidecar B │ │  Mobile  │               │
│        │ (local    │ │(local    │ │ (direct  │               │
│        │  relay)   │ │ relay)   │ │  to      │               │
│        └─────┬─────┘ └───┬──────┘ │  hub) │               │
│              │            │        └──────────┘               │
│        ┌─────▼─────┐ ┌───▼──────┐                             │
│        │ Tauri     │ │ Tauri    │                             │
│        │ Webview A │ │Webview B │                             │
│        └───────────┘ └──────────┘                             │
│                                                                │
│  Desktop: Webview ↔ Sidecar ↔ Hub ↔ other devices          │
│  Mobile:  App ↔ Hub ↔ other devices                        │
└─────────────────────────────────────────────────────────────────┘
```

Desktop clients get fast local sync through the sidecar (WebSocket on localhost, sub-millisecond). The sidecar syncs with the hub for cross-device coordination. Mobile clients connect directly to the hub since they have no sidecar.

Yjs CRDTs handle merge on all paths. If a desktop makes edits while the hub is temporarily unreachable, the local Y.Doc persists changes in IndexedDB. When the sidecar reconnects, CRDTs merge automatically.

### Why Local Sidecars Sync

The local sidecar's sync relay is not redundant with the hub -- it serves a fundamentally different role. Three reasons it exists:

**1. Multiple Y.Doc contexts within a single desktop app.** A desktop runs multiple Yjs documents simultaneously: workspace metadata, individual documents, chat conversations, settings. These Y.Docs all sync through the sidecar's WebSocket rooms. Even when the hub is unreachable, these local documents need to stay coordinated -- a workspace rename should reflect everywhere within the same app immediately, not after the hub comes back online.

**2. Offline resilience.** The sidecar ensures the desktop app is fully functional without any network. Edits persist to IndexedDB through the sidecar's sync layer. When connectivity returns, the sidecar relays accumulated changes to the hub, and CRDTs merge everything automatically. The user never notices the gap. Without the sidecar, the desktop would need a direct WebSocket to the hub for every sync operation, and any network interruption would stall real-time collaboration within the app itself.

**3. Latency.** The sidecar provides sub-millisecond WebSocket sync on localhost. For keystroke-level CRDT sync (typing in a shared document), the difference between `<1ms` (localhost sidecar) and `5-50ms` (remote hub) is perceptible. The sidecar acts as a **local write-ahead cache**: it accepts writes instantly, syncs the UI immediately, then relays upstream to the hub in the background.

```
Data flow (with sidecar -- actual design):
  Webview <--(sub-ms)--> Sidecar <--(background, async)--> Hub <--> Other devices

Data flow (without sidecar -- rejected alternative):
  Webview <--(5-50ms, network-dependent)--> Hub <--> Other devices
```

The sidecar always runs for consistency. Even when the hub is on the same machine (self-hosted desktop), the overhead is negligible and it keeps client code simple: always connect to `localhost:3913` for sync, always connect to `hubUrl` for AI and auth.

### AI Streaming Flow

All AI goes through the hub. One flow for all devices and all providers:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ALL AI STREAMING                             │
│                                                                │
│  Any Client                      Hub Server                 │
│  ┌─────────────┐   POST /ai/chat  ┌──────────────────┐        │
│  │ Desktop,    │ ────────────────▶ │ resolveProvider() │        │
│  │ Mobile, or  │                   │                  │        │
│  │ Extension   │                   │ Cloud provider?  │        │
│  │             │                   │  → resolveApiKey │        │
│  │             │                   │  → call provider │        │
│  │             │   SSE stream      │                  │ ──────▶│  OpenAI
│  │             │ ◀──────────────── │ Ollama?          │ ──────▶│  Anthropic
│  │             │                   │  → OLLAMA_HOST   │ ──────▶│  Gemini
│  └─────────────┘                   │  → no key needed │ ──────▶│  Ollama
│                                    │                  │        │
│                                    │ toSSEResponse()  │        │
│                                    └──────────────────┘        │
│                                                                │
│  Client code:                                                  │
│  const chat = useChat({                                        │
│    connection: fetchServerSentEvents(`${hubUrl}/ai/chat`),  │
│  });                                                           │
│                                                                │
│  That's it. One endpoint. No routing.                          │
└─────────────────────────────────────────────────────────────────┘
```

The server-side AI plugin is unchanged from the current implementation. `resolveApiKey()` returns the stored key for cloud providers and `undefined` for Ollama (which doesn't need one). `createAdapter()` builds the right TanStack AI adapter. `chat()` streams the response. `toServerSentEventsResponse()` wraps it as SSE.

### Ollama Configuration

Ollama runs as a separate process. It's already a server at `localhost:11434`. The hub just needs to know where to reach it:

```
Self-hosted hub IS the desktop:
  OLLAMA_HOST=http://localhost:11434     ← zero hop, Ollama is right here

Self-hosted hub is a separate machine (Mac Mini, home server):
  OLLAMA_HOST=http://192.168.1.X:11434  ← Ollama runs on any LAN machine

Cloud hub (Epicenter hosted):
  OLLAMA_HOST not configured             ← Ollama unavailable (cloud has no local models)
  Selecting an Ollama model returns a clear error:
  "Ollama is not configured on this server"
```

The hub's settings UI (or config file) lets users set `OLLAMA_HOST`. The AI plugin reads it at request time:

```typescript
// On hub, createOllamaChat reads OLLAMA_HOST
ollama: (model: string, _apiKey: string) =>
  createOllamaChat(model, process.env.OLLAMA_HOST || 'http://localhost:11434'),
```

### OpenCode Integration (AI Coding Agent)

Each desktop runs a local OpenCode instance (from sst/opencode) as an AI-powered coding agent. OpenCode needs LLM provider access to function, but API keys live exclusively on the hub. The solution: the hub acts as a **provider-compatible reverse proxy** that OpenCode calls instead of the real provider APIs.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────┐
│         Hub Server                                        │
│  ┌─────────────────────┐  ┌────────────────────────┐     │
│  │   AI Proxy            │  │   AI Streaming          │     │
│  │   /proxy/{provider}/* │  │   /ai/chat (TanStack AI)│     │
│  │   (for OpenCode)      │  │   (for Epicenter chat)  │     │
│  └──────────┬──────────┘  └───────────┬────────────┘     │
│             │                          │               │
│             │   ┌────────────────┐   │               │
│             └──>│  Key Store    │<──┘               │
│                 │  (encrypted)  │                    │
│                 └──────┬─────────┘                    │
│                       │                              │
└───────────────────────┬─────────────────────────┘
                       │
          ┌─────────────┼─────────────┐
          │             │             │
     ┌────▼─────┐  ┌───▼─────┐  ┌───▼────┐
     │          │  │          │  │         │
     │Anthropic │  │ OpenAI   │  │ Ollama  │
     │          │  │          │  │         │
     └──────────┘  └──────────┘  └─────────┘
```

**How the proxy works:** The hub exposes `/proxy/{provider}/*` endpoints that are provider-API-compatible reverse proxies. They don't parse or understand the request body -- they perform a passthrough:

1. OpenCode sends a request to `hubUrl/proxy/anthropic/v1/messages` with the session token as the `Authorization` header
2. Hub validates the session token via Better Auth
3. Hub resolves the real API key for "anthropic" from the encrypted key store
4. Hub replaces the `Authorization` header with `Bearer <real-api-key>`
5. Hub forwards the request body unchanged to `api.anthropic.com/v1/messages`
6. Hub streams the SSE response back to OpenCode

This is ~30 lines of proxy code per provider. No request parsing needed.

**OpenCode configuration (injected at spawn time):**

```typescript
// Epicenter generates this on startup and injects via env var
const config = {
  provider: {
    anthropic: {
      options: {
        apiKey: sessionToken,  // Session token used as auth credential
        baseURL: `${hubUrl}/proxy/anthropic`,
      },
    },
    openai: {
      options: {
        apiKey: sessionToken,
        baseURL: `${hubUrl}/proxy/openai`,
      },
    },
    // ... same pattern for all providers
  },
};

process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
// Then spawn: opencode serve --port <port>
```

OpenCode natively supports custom `baseURL` per provider in its config. The `apiKey` field carries the session token, which the hub validates and swaps for the real key. Keys never leave the hub.

**Why proxy over key distribution:** Distributing keys to each device (via `auth.json` injection) would be simpler but violates the "keys never leave hub" principle. The proxy approach means:
- Key revocation is instant (hub stops proxying, no stale keys on devices)
- No key rotation sync across devices
- Session token is the only credential on each device
- Same trust model as the rest of the topology (everything goes through hub)

**Plugin execution (always local):**

```
Desktop A                          Desktop B
┌────────────────────────┐      ┌────────────────────────┐
│ OpenCode Instance A      │      │ OpenCode Instance B      │
│                          │      │                          │
│ XDG-isolated to          │      │ XDG-isolated to          │
│ Epicenter app data       │      │ Epicenter app data       │
│                          │      │                          │
│ Provider baseURLs        │      │ Provider baseURLs        │
│  → hub proxy          │      │  → hub proxy          │
│                          │      │                          │
│ Local MCP servers        │      │ Local MCP servers        │
│  (spawned processes)     │      │  (spawned processes)     │
│                          │      │                          │
│ Local plugins            │      │ Local plugins            │
│  (.opencode/plugins/)    │      │  (.opencode/plugins/)    │
│                          │      │                          │
│ Generated Epicenter      │      │ Generated Epicenter      │
│  tools from workspace    │      │  tools from workspace    │
│  schema                  │      │  schema                  │
│                          │      │                          │
│ Full local file access   │      │ Full local file access   │
└────────────────────────┘      └────────────────────────┘
```

Plugin execution is always local -- each desktop spawns its own MCP servers and runs its own plugins. The cloud-hosted hub (Cloudflare Workers) cannot and does not need to run arbitrary code. Plugin _lists_ (npm package names) sync via Yjs so all devices install the same plugins, but execution is per-device. Generated Epicenter tools are regenerated from the workspace schema on each device at startup (see `opencode-integration-architecture` spec).

**OpenCode and the cloud hub:** The proxy pattern works identically whether the hub is self-hosted or cloud-hosted. Cloudflare Workers excel at HTTP proxying -- it's one of their core use cases. No arbitrary code execution is needed on the hub for OpenCode support.

### Authentication Across the Topology

```
                         Better Auth
                    ┌────────────────────┐
                    │  Hub Server     │
                    │  (self-hosted OR   │
                    │   Epicenter cloud) │
                    │                    │
                    │  POST /auth/login  │──► Returns session token
                    │  POST /auth/signup │
                    │  GET  /auth/session│──► Validates token
                    └────────┬───────────┘
                             │
                    Session token (cookie or bearer)
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         ┌────▼────┐   ┌────▼────┐    ┌────▼────┐
         │Desktop  │   │Desktop  │    │ Mobile  │
         │ client  │   │ client  │    │ client  │
         │         │   │         │    │         │
         │ Stores  │   │ Stores  │    │ Stores  │
         │ session │   │ session │    │ session │
         │ token   │   │ token   │    │ token   │
         └────┬────┘   └────┬────┘    └─────────┘
              │              │
         ┌────▼────┐   ┌────▼────┐
         │ Local   │   │ Local   │
         │ sidecar │   │ sidecar │
         │         │   │         │
         │Validates│   │Validates│
         │requests │   │requests │
         │via token│   │via token│
         └─────────┘   └─────────┘
```

**Auth flow:**

1. User logs in via Better Auth on the hub server (same flow whether hub is self-hosted or cloud)
2. Client receives a session token
3. Client stores the session token locally (Tauri app settings, mobile secure storage, chrome.storage.local)
4. For requests to the **hub server**: client includes session token as cookie or bearer header: hub validates directly via Better Auth
5. For requests to the **local sidecar**: client includes the same session token: sidecar validates by calling `GET /auth/session` on the hub (response cached with TTL)

**Why this works for interchangeability:**

```
Self-hosted hub:                    Cloud hub:
──────────────────                    ──────────────
hubUrl = "https://home.tailscale"   hubUrl = "https://api.epicenter.so"
Better Auth (same config)              Better Auth (same config)
Session token format: identical        Session token format: identical
Client behavior: identical             Client behavior: identical
```

The client stores `hubUrl` and a session token. It doesn't know or care whether the hub is a binary on a Mac Mini or a Cloudflare Worker. The API surface is the same.

**Third-Party Hosted Workspaces (OAuth Provider)**

The auth flow above covers first-party clients. The Tauri desktop app, mobile app, and browser extension. These clients are same-origin (or trusted-origin) with the hub and use session tokens directly. Third-party developers who host workspace apps at their own domains (e.g., `myapp.com`) need a different mechanism because they are cross-origin with the hub and cannot share session cookies.

For this case, the hub acts as an **OAuth 2.1 / OIDC identity provider** using Better Auth's `oauthProvider` plugin. Third-party apps register as OAuth clients, redirect users to the hub's authorization endpoint for login, receive OAuth access tokens (JWTs) on callback, and use those tokens to authenticate WebSocket connections to hub sync rooms. The hub validates these JWTs on WebSocket upgrade using its own JWKS keys, no external identity provider or third-party validation service is involved.

This adds a second column to the auth topology: first-party clients authenticate with session tokens, third-party hosted workspaces authenticate with OAuth access tokens. Both token types resolve to the same user accounts, authorize access to the same sync rooms, and are validated by the same hub. From the sync layer's perspective, the token type is an implementation detail. The WebSocket upgrade handler accepts either. See `specs/20260225T210000-workspace-apps-orchestrator.md`, section "Third-Party Auth Flow (Login with Epicenter)" for the full OAuth flow design.

### Hub URL Discovery

Users need to tell each device where the hub server lives. How they do this depends on the mode:

**Epicenter Cloud (built-in URL):**

The cloud hub URL is hardcoded in the client: `https://api.epicenter.so`. The user doesn't configure anything; they just sign up and log in. Every device ships with this URL as the default.

```
Onboarding flow (cloud):
  1. Open Epicenter → defaults to cloud mode
  2. Sign up / Log in → Better Auth on api.epicenter.so
  3. Done. All devices use the same built-in URL.
```

**Self-hosted (manual configuration):**

The user enters their hub server URL once per device. The URL is persisted in platform-specific storage:

| Platform | Storage Mechanism | Configuration UX |
| --- | --- | --- |
| Desktop (Tauri) | Tauri app settings (persisted file) | Settings UI text field |
| Mobile | App secure storage | Settings UI or QR code scan |
| Browser Extension | `chrome.storage.local` (already exists as `serverUrlItem`) | Settings UI text field |

```
Onboarding flow (self-hosted):
  1. Open Epicenter → choose "Self-hosted"
  2. Enter hub URL (e.g., https://my-server.tailscale.net:3913)
     OR scan QR code from hub's admin UI
  3. Log in → Better Auth on the self-hosted hub
  4. Done. URL persisted locally. Never asked again.
```

**This is a one-time-per-device setup.** Once the hub URL is persisted, the device remembers it across app restarts, updates, and network changes. The user configures each device once and never thinks about it again: similar to how you sign into iCloud once per device.

**QR code flow (recommended for mobile):**
1. Hub server's admin UI (`hubUrl/admin`) displays a QR code containing the server URL and a one-time setup token
2. User opens Epicenter on mobile → "Scan Setup Code"
3. App reads the URL and token, validates against the hub, and persists the connection
4. This avoids error-prone manual URL entry on mobile keyboards

**Tailscale (recommended for self-hosted networking):**

For self-hosted setups, Tailscale is the recommended network layer. It gives each machine a stable hostname (e.g., `macmini.tailnet-name.ts.net`) that works across networks (home, office, cellular), avoids manual IP management, and provides encrypted tunnels with no port forwarding. The hub URL stays the same whether the user is at home or on cellular, no reconfiguration needed when switching networks.

### Sidecar Auth Boundary

The local sidecar must reject requests from unauthorized origins (prevents random websites from hitting localhost):

```
Random website tries: POST http://localhost:3913/workspaces
  → CORS blocks (origin not in allowlist)
  → OR: 401 (no valid session token)
  → Request rejected

Tauri webview: POST http://localhost:3913/workspaces
  → Origin: tauri://localhost (whitelisted)
  → Bearer: <session-token> (validated against hub, cached)
  → 200 OK
```

The allowlist is configured when the sidecar starts. Only the Tauri webview's origin and optionally the hub server's origin are permitted.

### Server Discovery (Yjs Awareness)

Server discovery uses the Yjs Awareness protocol on a shared coordination document rather than dedicated HTTP endpoints. Every device already maintains a WebSocket connection to the hub for sync -- Awareness piggybacks on that existing connection at zero additional network cost.

**How it works:** All devices (sidecars and clients) connect to a shared discovery room on the hub (`/rooms/_epicenter_discovery/sync`). Each device sets its local Awareness state with its capabilities. Awareness broadcasts presence changes to all connected participants in real-time. When a device disconnects (graceful shutdown or crash), the Awareness protocol automatically removes its state after a configurable timeout (~30s).

```
Sidecar A (on boot, connects to discovery room):
  const provider = new WebsocketProvider(hubUrl, '_epicenter_discovery', doc)
  provider.awareness.setLocalState({
    type: 'sidecar',
    url: 'http://192.168.1.100:3913',
    deviceId: 'device_abc123',
    capabilities: ['sync', 'workspace'],
    hostname: "Braden's MacBook Pro"
  })
  // That's it. No register endpoint. No heartbeat.

Client (any device, already connected to discovery room):
  provider.awareness.on('change', () => {
    const servers = Array.from(provider.awareness.getStates().values())
      .filter(state => state.type === 'sidecar')
    // servers = [
    //   { type: 'sidecar', url: '...', deviceId: '...', capabilities: [...], hostname: '...' },
    //   ...
    // ]
  })
  // Real-time push. No polling. No GET endpoint.

Sidecar A crashes or shuts down:
  // WebSocket closes -> Awareness timeout (30s) -> state auto-removed
  // All connected clients receive the removal via 'change' event
  // Zero cleanup code needed.
```

**Why Awareness over HTTP endpoints:** The coupling between discovery and sync is a feature, not a bug. A device that can't maintain a sync connection to the hub also can't meaningfully participate in the network -- there's nothing to discover it for. By using Awareness, we eliminate 4 HTTP endpoints (register, heartbeat, unregister, list), a background cleanup job, and all stale-entry management. The trade-off is that discovery requires an active WebSocket to the hub, which every participating device already has.

### How Keys Work

API keys live exclusively on the hub server. The existing `server-side-api-key-management` spec applies without changes:

```
Hub Server:
  ~/.epicenter/server/
  ├── keys.json        ← Encrypted provider keys (AES-256-GCM)
  ├── master.key       ← 256-bit encryption key
  └── config.json      ← Server configuration (includes OLLAMA_HOST)

Resolution chain (on hub):
  1. x-provider-api-key header?  → use it (backward compat)
  2. Server key store has key?   → use it (primary path)
  3. Provider is ollama?         → no key needed, proceed
  4. undefined                   → 401 error

Local Sidecar:
  NO key store. NO AI endpoints. NO provider keys.
  Sync relay + workspace API only.
```

For cloud deployment (Epicenter's hosted hub), keys move to Postgres with per-user isolation. Same API surface, different storage backend.

## Implementation Plan

### Phase 1: Hub Server Composition

Define the hub server as a distinct composition of existing plugins, plus Better Auth.

- [ ] **1.1** Create `createHubServer()` in `@epicenter/server` that composes: sync plugin + AI plugin (all providers) + key management plugin + Better Auth plugin + discovery room
- [ ] **1.2** Add Better Auth integration as an Elysia plugin (`createAuthPlugin()`) wrapping Better Auth's Elysia adapter
- [ ] **1.3** Add `OLLAMA_HOST` configuration to the AI plugin (default `http://localhost:11434`, configurable via env var or settings)
- [ ] **1.4** Set up the shared discovery room (`_epicenter_discovery`) on the hub's sync layer. Devices connecting to this room use Awareness to broadcast and discover presence. No dedicated HTTP endpoints needed.
- [ ] **1.5** Ensure the hub server can be started as a standalone binary (extends the `unified-cli-server-sidecar` spec)

### Phase 2: Sidecar Slimdown

Strip the local sidecar to sync + workspace only.

- [ ] **2.1** Create `createSidecarServer()` composition: sync plugin + workspace plugin (NO AI plugin, NO key management)
- [ ] **2.2** Implement session token validation on the local sidecar: validates against hub's `/auth/session` endpoint with response caching
- [ ] **2.3** Configure CORS allowlist on sidecar startup (Tauri webview origin + hub origin)
- [ ] **2.4** Wire the auth boundary into the Tauri sidecar startup flow

### Phase 3: Client Configuration

Update clients to always hit hub for AI.

- [ ] **3.1** Add `hubServerUrl` in client settings (cloud mode: hardcoded, self-hosted mode: user-configured)
- [ ] **3.2** Client AI connection: `fetchServerSentEvents(hubServerUrl + "/ai/chat")`: one endpoint, no routing
- [ ] **3.3** Add hub URL configuration UI (onboarding flow: cloud vs self-hosted choice)
- [ ] **3.4** Add mode selection to onboarding: "Use Epicenter Cloud" (default) vs "Connect to self-hosted server"

### Phase 4: Server Discovery (Awareness Integration)

Wire up Yjs Awareness-based device discovery across the topology.

- [ ] **4.1** Local sidecar connects to the `_epicenter_discovery` room on hub and sets Awareness state (type, url, deviceId, capabilities, hostname) on boot
- [ ] **4.2** Client subscribes to Awareness changes on the discovery room and renders device presence UI
- [ ] **4.3** Verify auto-cleanup: when a sidecar disconnects (graceful or crash), its Awareness state is removed and all clients are notified

### Phase 5: OpenCode Integration

Wire up OpenCode as a local AI coding agent on each desktop, with provider requests proxied through the hub.

- [ ] **5.1** Add provider-compatible reverse proxy endpoints to hub (`/proxy/{provider}/*`): validate session token, resolve API key from store, swap auth header, forward request unchanged, stream response back
- [ ] **5.2** Implement XDG-isolated OpenCode spawner in Tauri sidecar startup (see `opencode-integration-architecture` spec)
- [ ] **5.3** Generate `OPENCODE_CONFIG_CONTENT` with provider baseURLs pointing to hub proxy and session token as apiKey
- [ ] **5.4** Generate Epicenter tools plugin from workspace schema at startup
- [ ] **5.5** Wire OpenCode lifecycle to app lifecycle (spawn on app start, kill on app quit)
- [ ] **5.6** Plugin list sync: read `opencode_plugins` table from Yjs, generate `opencode.json`, OpenCode auto-installs npm packages
- [ ] **5.7** Runtime reconfiguration: use `PATCH /config` on local OpenCode to update provider config without restart (e.g., after session token refresh)

### Phase 6: Cloud Hub (Future)

- [ ] **6.1** Deploy hub server composition to Cloudflare Workers + Durable Objects (sync layer from `deployment-targets-research` spec)
- [ ] **6.2** Postgres key store for multi-user API key management
- [ ] **6.3** Better Auth with social login (Google, GitHub) for the cloud variant

## Edge Cases

### Hub server goes down

The hub is a single point of failure for cross-device features. This is an inherent property of a coordination server -- every multi-device tool (Linear, Figma, Obsidian Sync) has the same SPOF. The local-first architecture softens the blow significantly:

**Desktop (graceful degradation):**
1. Local editing continues uninterrupted -- the sidecar handles all local Y.Doc sync independently of the hub
2. Multiple Y.Doc contexts (workspaces, documents, chat) continue syncing through the local sidecar
3. Edits persist to IndexedDB through the sidecar's sync layer -- nothing is lost
4. AI is unavailable (all AI routes through hub)
5. Cross-device sync is paused (no relay to other devices)
6. Auth token validation falls back to cached validation (tokens work during TTL window, default 5 minutes)
7. When hub returns, sidecar reconnects and CRDTs merge all accumulated changes automatically -- no user intervention

**Mobile (hard failure):**
1. Mobile loses all functionality -- sync, AI, and auth are all hub-dependent
2. Mobile has no sidecar or offline persistence layer
3. This is acceptable: mobile is a secondary access point, not a primary workspace

**Recovery:**
1. All devices reconnect automatically when hub comes back
2. CRDT merge is deterministic -- no conflicts, no data loss, regardless of how long the hub was down
3. The longer the outage, the larger the merge, but Yjs handles this efficiently

### Desktop is on a different network than hub

1. If hub is on local network only (no Tailscale/ngrok), desktop on cellular can't reach it
2. Mitigation: recommend Tailscale for self-hosted hubs (stable URL across networks)
3. For Epicenter cloud: always reachable (public URL)

### Two devices with the same device ID

1. Device IDs are generated per-installation (nanoid), so collisions are astronomically unlikely
2. If it somehow happens, both devices set Awareness state with the same deviceId -- each has a unique Awareness clientId, so both appear in the state map
3. Clients see two entries with the same deviceId but different clientIds. UI can deduplicate or show both
4. When either disconnects, only its Awareness entry is removed (no interference with the other)

### User switches from self-hosted to cloud (or vice versa)

1. User changes `hubUrl` in settings to the new hub (or switches mode)
2. User logs in to the new hub via Better Auth
3. Sync reconnects to the new hub's relay
4. API keys must be re-entered on the new hub (keys don't sync between hubs)
5. Y.Doc data is preserved locally: CRDTs merge when the new relay receives updates
6. Conversation history persists (stored in Y.Doc, not on the hub)

### Ollama not reachable from hub

1. Client sends `provider: 'ollama'` to hub
2. Hub's AI plugin tries to connect to `OLLAMA_HOST`
3. Connection refused → TanStack AI returns an error SSE event
4. Client shows descriptive error:
   - If `OLLAMA_HOST` not configured: "Ollama is not configured on this server"
   - If configured but unreachable: "Cannot reach Ollama at [host]. Is it running?"
5. User can switch to a cloud provider in the chat UI

### Cloud hub with no Ollama

1. Epicenter cloud doesn't run Ollama (no local GPU)
2. Selecting an Ollama model returns: "Ollama is not available on Epicenter Cloud. Use a cloud provider or switch to a self-hosted server."
3. This is the expected behavior: cloud = cloud providers, self-hosted = cloud providers + Ollama

### Hub down with OpenCode running

1. OpenCode's provider requests go through the hub proxy -- if hub is down, all LLM calls fail
2. OpenCode can still use local tools (file editing, search, LSP) but cannot call any AI model
3. Local MCP servers and plugins continue running (they don't depend on hub)
4. When hub returns, OpenCode resumes normally -- next LLM call goes through the proxy
5. This is consistent with the rest of the topology: hub down = no AI anywhere

### Session token expires while OpenCode is running

1. OpenCode sends a request to the hub proxy with an expired session token
2. Hub returns 401 Unauthorized
3. Epicenter detects the 401, refreshes the session token via Better Auth
4. Epicenter updates OpenCode's provider config via `PATCH /config` on the local OpenCode server (no restart needed)
5. Next OpenCode LLM call uses the fresh session token

### OpenCode plugin needs network access

1. Local MCP servers and plugins run arbitrary TypeScript on the desktop -- they can make any network call
2. If a plugin needs to call an external API with its own key, that key is managed by the plugin, not by the hub
3. Hub's key store is specifically for LLM provider keys, not arbitrary plugin credentials
4. This is fine -- plugins are locally trusted code running on the user's own machine

## Open Questions

1. ~~**Should server discovery use HTTP endpoints or Yjs Awareness?**~~ **Decided: Yjs Awareness.**
   - Every device already maintains a WebSocket connection to the hub for sync. Awareness piggybacks on that connection at zero additional cost. The coupling (discovery depends on sync) is a feature: a device that can't sync also can't meaningfully participate in discovery. This eliminates 4 HTTP endpoints, a heartbeat loop, and all stale-entry cleanup logic. See the "Server Discovery (Yjs Awareness)" section above for the full design.

2. **Should the local sidecar validate tokens on every request or cache the validation?**
   - Every request: always fresh, but adds latency (HTTP call to hub per request).
   - Cached with TTL: fast after first validation, but stale tokens work until TTL expires.
   - **Recommendation**: Cache with a 5-minute TTL. The sidecar is on the same machine as the client: the threat model is local process isolation, not internet-facing auth. A 5-minute window is acceptable.

3. **How does the hub server's Better Auth config stay identical between self-hosted and cloud?**
   - Options: (a) Ship the same Better Auth config in the binary and the cloud deployment, (b) Allow config divergence (cloud adds social login, self-hosted is email/password only), (c) Use a shared config package.
   - **Recommendation**: (b) Allow divergence. Self-hosted starts with email/password or passkeys. Cloud adds Google/GitHub social login. The session token format is the same regardless: clients don't care how the user authenticated.

4. **Should `OLLAMA_HOST` be configurable via settings UI or env var only?**
   - Env var: simple for self-hosted users who manage server configs. Set-and-forget.
   - Settings UI: accessible from any device via the hub's admin page. Better UX.
   - Both: env var as default, settings UI as override.
   - **Recommendation**: Both. Env var for initial setup (`OLLAMA_HOST=http://...`), plus a settings endpoint (`PUT /api/settings/ollama-host`) for runtime changes.

5. **What happens to conversation history when switching hubs?**
   - Conversation messages are stored in Y.Doc (chatMessages table), not on the hub server.
   - When the user switches `hubUrl`, the Y.Doc persists locally. When sync reconnects through the new hub's relay, CRDT merge handles convergence.
   - **Recommendation**: No action needed. This is a natural benefit of the local-first architecture.

6. **Should the hub's `oauthProvider` plugin allow dynamic client registration (RFC 7591) or require manual registration only?**
   - Dynamic registration: third-party developers register their OAuth client programmatically via a registration endpoint. Lower friction, but opens the door to abuse (spam registrations, token farming).
   - Manual registration: developers register through a hub admin UI or CLI command. Higher friction, but full control over which apps can authenticate users.
   - **Recommendation**: Start with manual registration only. The number of third-party workspace apps will be small initially. Add dynamic registration later if developer onboarding friction becomes a bottleneck, with rate limiting and admin approval workflows.

7. **Should the local sidecar sync relay be optional?**
   - If the hub is on the same machine (self-hosted on desktop), the sidecar sync relay is redundant: the webview could connect directly to the hub.
   - If the hub is remote, the sidecar provides meaningful latency benefits (local WebSocket vs remote).
   - **Recommendation**: Always run the sidecar for consistency. The overhead is minimal and it simplifies the client code (always connect to `localhost:3913` for sync).

## Success Criteria

- [ ] Hub server starts with Better Auth + sync + AI (all providers) + key management + discovery room
- [ ] Desktop Tauri sidecar starts with sync + workspace only (no AI plugin)
- [ ] Mobile client connects to hub for sync and AI
- [ ] Desktop client connects to hub for AI, local sidecar for sync
- [ ] All AI requests (cloud and Ollama) route through hub: no client-side provider routing
- [ ] `OLLAMA_HOST` is configurable and the hub calls Ollama at the configured host
- [ ] Sidecar connects to hub's discovery room and appears in Awareness state visible to all clients
- [ ] Session token from hub authenticates requests to both hub and local sidecar
- [ ] Switching `hubUrl` from self-hosted to cloud (or vice versa) works without data loss
- [ ] Random website cannot hit local sidecar endpoints (CORS + token rejection)
- [ ] API keys configured on hub are used for AI requests from any device
- [ ] Cloud mode works out of the box with hardcoded URL; self-hosted mode works with manual URL entry
- [ ] OpenCode instance starts on each desktop with provider baseURLs proxied through hub
- [ ] OpenCode LLM calls go through hub proxy -- session token validated, real API key injected, response streamed back
- [ ] OpenCode plugins and MCP servers run locally on each desktop (no cloud execution)
- [ ] Plugin list syncs via Yjs -- all devices install the same npm plugins
- [ ] Generated Epicenter tools plugin reflects the current workspace schema
- [ ] Session token refresh propagates to OpenCode without restart (via PATCH /config)
- [ ] Hub proxy works identically for self-hosted and cloud-hosted hubs

## References

- `packages/server/src/server.ts`: Current `createServer()` composition
- `packages/server/src/ai/plugin.ts`: AI chat plugin with `resolveApiKey()`
- `packages/server/src/ai/adapters.ts`: Provider adapters, Ollama exemption, `PROVIDER_ENV_VARS`
- `packages/server/src/sync/plugin.ts`: Sync plugin (WebSocket rooms)
- `apps/tab-manager/src/lib/state/settings.ts`: `serverUrlItem` in chrome.storage.local
- `apps/tab-manager/src/lib/state/ai-chat-state.svelte.ts`: Current AI chat state
- `specs/20260219T195800-server-architecture-rethink.md`: Layered server architecture
- `specs/20260220T080000-plugin-first-server-architecture.md`: Plugin composition pattern
- `specs/20260220T133004-unified-local-server-architecture.md`: Tauri sidecar server
- `specs/20260222T073156-unified-cli-server-sidecar.md`: Compiled binary server
- `specs/20260219T200000-deployment-targets-research.md`: Cloud deployment (CF Workers + DOs)
- `specs/20260222T195800-server-side-api-key-management.md`: Encrypted key store
- `specs/20260121T170000-sync-architecture.md`: Three sync modes
- `specs/20260222T200800-server-endpoint-security.md`: CORS + bearer token auth boundary
- `specs/20260109T140700-opencode-integration-architecture.md`: OpenCode as AI backend (XDG isolation, plugin generation, spawn lifecycle)
