# Remove Key Store, Simplify API Key Resolution

**Date**: 2026-02-23
**Status**: Implemented
**Author**: AI-assisted

## Overview

Remove the encrypted key store (`keys/`) and key management REST API from the hub server. Simplify `resolveApiKey()` to a two-step chain: request header → environment variable → 401. The proxy plugin switches from key store lookups to env var lookups.

## Motivation

### Current State

API key resolution walks three steps, with an encrypted key store in the middle:

```typescript
// packages/server/src/ai/adapters.ts
export async function resolveApiKey(
	provider: SupportedProvider,
	headerKey?: string,
	keyStore?: KeyStore,
): Promise<string | undefined> {
	if (headerKey) return headerKey;

	if (keyStore) {
		const storeKey = await keyStore.get(provider);
		if (storeKey) return storeKey;
	}

	const envVarName = PROVIDER_ENV_VARS[provider];
	if (envVarName) return process.env[envVarName];

	return undefined;
}
```

The key store (`keys/store.ts`) is ~243 lines of AES-256-GCM encryption with a master key file at `~/.epicenter/server/master.key` and encrypted keys at `~/.epicenter/server/keys.json`. A REST API (`keys/plugin.ts`, ~78 lines) exposes PUT/GET/DELETE endpoints at `/api/provider-keys`. The proxy plugin (`proxy/plugin.ts`) also reads from the key store.

This creates problems:

1. **Encryption is security theater**: `master.key` sits in the same directory as `keys.json`. Anyone with filesystem access decrypts trivially. It's a lock with the key taped to it.
2. **Async decryption in the hot path**: Every AI chat request and every proxy request decrypts from disk. `process.env` lookups are nanoseconds.
3. **~400 lines of unnecessary code**: `store.ts` (243 lines) + `plugin.ts` (78 lines) + `index.ts` (3 lines) + integration wiring across `hub.ts`, `adapters.ts`, `plugin.ts`, and `proxy/plugin.ts`.
4. **Redundant with env vars**: The key store solves "how does the server get keys": but env vars already solve this universally. On cloud infrastructure, you use the hosting provider's secrets management (Railway, Fly, Vercel env vars). Locally, you set them in `.env`. The key store duplicates what the deployment environment already provides.
5. **Two sources of truth**: When both key store and env vars have a value for the same provider, the key store wins silently. This is confusing and untestable without reading the code.

### Desired State

Two-step resolution with clear semantics:

```typescript
export function resolveApiKey(
	provider: SupportedProvider,
	headerKey?: string,
): string | undefined {
	if (headerKey) return headerKey;

	const envVarName = PROVIDER_ENV_VARS[provider];
	return process.env[envVarName];
}
```

- **Header**: User's own key (BYOK: "use my account, my billing")
- **Env var**: Operator's key (hub admin set it in `.env` or hosting dashboard)
- No key store, no encryption, no REST API for key management, no async

## Research Findings

### Who uses the key store?

| Consumer           | File                       | Usage                                                                 |
| ------------------ | -------------------------- | --------------------------------------------------------------------- |
| AI plugin          | `ai/plugin.ts:66,85`       | Passes `keyStore` to `resolveApiKey()`                                |
| `resolveApiKey()`  | `ai/adapters.ts:101-120`   | Step 2: `keyStore.get(provider)`                                      |
| Hub server         | `hub.ts:89-93,127,140-142` | Creates key store, passes to AI plugin, mounts key management + proxy |
| Key management API | `keys/plugin.ts:34-77`     | PUT/GET/DELETE at `/api/provider-keys`                                |
| Proxy plugin       | `proxy/plugin.ts:67,106`   | `keyStore.get(provider)` for forwarded requests                       |
| Package exports    | `index.ts:21-25`           | Exports `createKeyStore`, `KeyStore`, `createKeyManagementPlugin`     |

### Who sends `x-provider-api-key`?

No client currently sends this header. The only consumer of `/ai/chat` is `apps/tab-manager/src/lib/state/chat.svelte.ts:173-185`, which sends only body params (`provider`, `model`, `conversationId`, `systemPrompt`). The header path exists for forward compatibility (BYOK) but is currently unused.

### Deployment contexts

| Context                    | Who sets keys      | How                                                                                  | Key store useful?                            |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| Cloud hub (Braden's infra) | Hub operator       | `.env` / hosting secrets dashboard                                                   | No: env vars are native                     |
| Self-hosted hub            | Technical user     | `.env` file                                                                          | No: same as cloud                           |
| Self-hosted hub            | Non-technical user | Needs a UI                                                                           | Partially: but could use simpler approaches |
| Local sidecar              | N/A                | Sidecar does NOT do AI (`sidecar.ts:73`: "The sidecar does NOT handle AI streaming") | N/A                                          |

**Key finding**: The sidecar never does inference. Only the hub resolves API keys. For both cloud and self-hosted hubs, env vars are the standard mechanism. The key store's only advantage (runtime updates without restart) can be achieved by writing to `process.env` directly: no encryption needed.

### Why the server-side key store is the wrong layer

The key store was built to answer: "How do users manage their API keys on the hub?" But that question has a better answer that aligns with Epicenter's architecture.

**User API keys are a client-side concern, not a server-side one.** Epicenter already has the primitives to handle this:

1. **Encrypted Yjs workspaces**: `packages/epicenter` supports encrypted Y.Doc storage. API keys can live in a workspace that syncs like any other workspace but is encrypted client-side using the user's auth credentials against the hub.
2. **Local-first by design**: The user's Tauri app already stores settings locally (see `apps/whispering/src/lib/settings/settings.ts` with `apiKeys.openai`, `apiKeys.anthropic`, etc.). These keys are already on the client. The client just needs to include the decrypted key in the `x-provider-api-key` header when making AI requests.
3. **The hub never needs to see stored keys**: In the BYOK flow, the client decrypts its own key from its local encrypted workspace and sends it per-request. The hub receives it, uses it for that one API call, and never persists it. This is strictly better security than storing keys on the server.

The server-side key store tried to centralize something that should stay decentralized. Two separate concerns got conflated:

- **Operator keys** (the hub admin's API keys for running the service) → env vars. Set once, used for all users. Standard deployment practice.
- **User keys** (individual BYOK keys) → client-side encrypted storage, sent per-request in headers. The hub is a stateless proxy for these.

The key store was trying to be both, and doing neither well. Removing it makes the boundary clear: the server owns operator config (env vars), the client owns user config (local encrypted workspaces).

## Design Decisions

| Decision                                 | Choice | Rationale                                                                   |
| ---------------------------------------- | ------ | --------------------------------------------------------------------------- |
| Remove key store entirely                | Yes    | Security theater, redundant with env vars, ~400 lines of code               |
| Remove key management REST API           | Yes    | No key store = no CRUD endpoints needed                                     |
| Keep `x-provider-api-key` header         | Yes    | BYOK is a valid use case, even if no client sends it today                  |
| Make `resolveApiKey()` synchronous       | Yes    | No async key store lookup = no need for `async`/`Promise`                   |
| Proxy plugin reads env vars              | Yes    | Same `PROVIDER_ENV_VARS` mapping, `process.env` instead of `keyStore.get()` |
| Remove `keyStore` from `HubServerConfig` | Yes    | Config becomes simpler, no `KeyStore \| true` union                         |
| Remove `AIPluginConfig.keyStore`         | Yes    | AI plugin no longer needs to know about key stores                          |
| Keep `PROVIDER_ENV_VARS` mapping         | Yes    | Still needed for env var lookups and error messages                         |

## Architecture

### Before (current)

```
Request → AI Plugin
           │
           ├─ 1. headers['x-provider-api-key']  → return
           ├─ 2. keyStore.get(provider)          → async decrypt from disk → return
           ├─ 3. process.env[PROVIDER_ENV_VARS]  → return
           └─ 4. undefined → 401

Hub Server
├── AI Plugin (keyStore param)
├── Key Management API (/api/provider-keys)  ← DELETE
├── Proxy Plugin (keyStore param)            ← MODIFY
└── Key Store (keys.json + master.key)       ← DELETE
```

### After (target)

```
Request → AI Plugin
           │
           ├─ 1. headers['x-provider-api-key']  → return
           ├─ 2. process.env[PROVIDER_ENV_VARS]  → return
           └─ 3. undefined → 401

Hub Server
├── AI Plugin (no config needed)
└── Proxy Plugin (reads env vars directly)
```

## Implementation Plan

### Phase 1: Simplify `resolveApiKey()`

- [x] **1.1** Remove `keyStore` parameter from `resolveApiKey()` in `adapters.ts`. Remove the key store step. Make the function synchronous (remove `async`/`Promise`).
- [x] **1.2** Remove `KeyStore` import from `adapters.ts`.
- [x] **1.3** Update `AIPluginConfig` in `ai/plugin.ts`: remove `keyStore` field. Remove `keyStore` local variable. Update `resolveApiKey()` call to drop the third argument. Remove `await` (now sync).
- [x] **1.4** Update `createAIPlugin()` call in `hub.ts:127`: remove `{ keyStore }` config.
- [x] **1.5** Update `createAIPlugin()` call in `server.ts:123`: already no keyStore, just verify no changes needed.

### Phase 2: Update proxy plugin

- [x] **2.1** In `proxy/plugin.ts`, replace `keyStore.get(provider)` with `process.env[PROVIDER_ENV_VARS[provider]]`. Import `PROVIDER_ENV_VARS` from `../ai/adapters`.
- [x] **2.2** Remove `KeyStore` import and `keyStore` from `ProxyPluginConfig`. The config keeps only `validateSession`.
- [x] **2.3** Update `createProxyPlugin()` call in `hub.ts:142`: remove `{ keyStore }` config. The proxy plugin no longer needs the key store condition guard.
- [x] **2.4** Update the 502 error message in proxy plugin: currently says "Add one via PUT /api/provider-keys/{provider}". Change to reference the env var name (e.g., "Set ANTHROPIC_API_KEY environment variable").

### Phase 3: Delete key store

- [x] **3.1** Delete `packages/server/src/keys/store.ts`.
- [x] **3.2** Delete `packages/server/src/keys/plugin.ts`.
- [x] **3.3** Delete `packages/server/src/keys/index.ts`.
- [x] **3.4** Delete the `keys/` directory entirely.
- [x] **3.5** Remove `keyStore` from `HubServerConfig` in `hub.ts`. Remove the key store resolution block (`hub.ts:89-93`). Remove the conditional mount block (`hub.ts:140-143`).
- [x] **3.6** Remove key store exports from `packages/server/src/index.ts` (lines 21-25: `createKeyManagementPlugin`, `createKeyStore`, `KeyStore`).

### Phase 4: Update tests

- [x] **4.1** Update `resolveApiKey` tests in `plugin.test.ts`: remove any key store test if present. Tests for header-wins-over-env and env-fallback stay. The `resolveApiKey` calls lose `await` (now sync).
- [x] **4.2** Verify all existing tests pass with `bun test` in `packages/server`.

### Phase 5: Update docs and comments

- [x] **5.1** Update JSDoc on `resolveApiKey()`: document the two-step chain.
- [x] **5.2** Update JSDoc on `createAIPlugin()`: remove key store references.
- [x] **5.3** Update JSDoc on `createHubServer()`: remove key store config docs and examples.
- [x] **5.4** Update JSDoc on `createProxyPlugin()`: document env var resolution instead of key store.
- [x] **5.5** Update 401 error message in `ai/plugin.ts:91` if needed: it already mentions env var, verify it's still accurate.

## Edge Cases

### Proxy plugin with no env var set

1. Request hits `/proxy/anthropic/v1/messages`
2. `process.env.ANTHROPIC_API_KEY` is undefined
3. Return 502 with message: "No API key configured for anthropic. Set ANTHROPIC_API_KEY environment variable."

### Header key sent to proxy endpoint

The proxy plugin currently doesn't check the `x-provider-api-key` header. It uses the Authorization header as a session token. This is correct and unchanged. The proxy's job is to swap a session token for the operator's real key. BYOK users wouldn't use the proxy. They'd call provider APIs directly (or the `/ai/chat` endpoint with their key in the header).

### Legacy `server.ts` (non-hub, non-sidecar mode)

`createServer()` in `server.ts:123` already calls `createAIPlugin()` with no config. This path already works with env vars only. No changes needed.

## Open Questions

1. **Should `resolveApiKey()` move out of `adapters.ts`?**
   - It's not adapter logic: it's key resolution. Could live in a standalone `resolve-key.ts` or just stay in `adapters.ts` since it's small and co-located with its only consumers.
   - **Recommendation**: Leave it in `adapters.ts` for now. It's 8 lines. Moving it adds a file for no real benefit.

2. **Should the proxy plugin also check the `x-provider-api-key` header?**
   - Currently it doesn't: the proxy is for session-token-authenticated users who don't have their own keys. BYOK users would call `/ai/chat` directly.
   - **Recommendation**: No. Keep the proxy as operator-key-only. Clear separation of concerns.

## Success Criteria

- [x] `resolveApiKey()` is synchronous, two-step: header → env var → undefined
- [x] `keys/` directory deleted entirely (store.ts, plugin.ts, index.ts)
- [x] No `KeyStore` type referenced anywhere in the codebase
- [x] No `/api/provider-keys` endpoints
- [x] Proxy plugin resolves keys from `process.env`
- [x] `HubServerConfig` has no `keyStore` field
- [x] `AIPluginConfig` removed entirely (was only `keyStore`)
- [x] All existing tests pass (161/161)
- [x] `bun run typecheck` passes for `packages/server`

## References

- `packages/server/src/ai/adapters.ts`: `resolveApiKey()`, `PROVIDER_ENV_VARS`
- `packages/server/src/ai/plugin.ts`: `createAIPlugin()`, `AIPluginConfig`
- `packages/server/src/ai/plugin.test.ts`: Tests for `resolveApiKey()` and AI plugin
- `packages/server/src/hub.ts`: `createHubServer()`, key store creation and mounting
- `packages/server/src/keys/store.ts`: Key store implementation (DELETE)
- `packages/server/src/keys/plugin.ts`: Key management REST API (DELETE)
- `packages/server/src/keys/index.ts`: Key store exports (DELETE)
- `packages/server/src/proxy/plugin.ts`: Proxy plugin, currently uses `keyStore.get()`
- `packages/server/src/index.ts`: Package-level exports
- `packages/server/src/server.ts`: Legacy server (already no key store)
- `specs/20260222T195800-server-side-api-key-management.md`: Original key store spec (now superseded)
