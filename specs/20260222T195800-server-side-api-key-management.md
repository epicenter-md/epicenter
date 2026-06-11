# Server-Side API Key Management

**Date**: 2026-02-22
**Status**: Superseded
**Superseded by**: `20260223T102844-remove-key-store-simplify-api-key-resolution.md`
**Author**: AI-assisted
**Related**: `20260213T030000-encrypted-api-key-vault.md` (zero-knowledge approach: different tradeoffs), `20260213T005300-encrypted-workspace-storage.md` (value-level Yjs encryption: broader scope)

> **Superseded (2026-02-23)**: This entire spec has been superseded. The encrypted key store, key management REST API (`/api/provider-keys`), and all associated code (`keys/store.ts`, `keys/plugin.ts`, `keys/index.ts`) have been removed. API key resolution is now a synchronous two-step chain: `x-provider-api-key` header → environment variable → 401.
>
> **Why**: The encrypted key store was security theater: `master.key` sat in the same directory as `keys.json`, making encryption trivial to bypass with filesystem access. It added ~400 lines of async decryption in the hot path for something `process.env` handles in nanoseconds. Env vars are the standard mechanism for both cloud (hosting provider secrets) and self-hosted (`.env` file) deployments. User-owned BYOK keys belong on the client side (encrypted Yjs workspaces, sent per-request via header), not in a server-side store. See the superseding spec for the full rationale.
>
> **Path note (2026-05-22):** The `~/.epicenter/server/` storage layout is also stale. Do not copy it into new server, auth, or credential-storage work.

## Overview

A REST API for managing provider API keys (OpenAI, Anthropic, etc.) on the Epicenter server. Clients store and retrieve keys through HTTP endpoints. The server owns the storage: versioned JSON locally, Postgres in cloud. Same API surface for both deployment targets. No client-side key storage needed.

## Motivation

### Current State

API keys are resolved at request time from two sources:

```typescript
// packages/server/src/ai/adapters.ts
export function resolveApiKey(
	provider: SupportedProvider,
	headerKey?: string,
): string | undefined {
	if (headerKey) return headerKey;
	const envVarName = PROVIDER_ENV_VARS[provider];
	if (envVarName) return process.env[envVarName];
	return undefined;
}
```

Whispering stores API keys client-side in settings (Yjs KV, synced):

```typescript
// apps/whispering/src/lib/settings/settings.ts
'apiKeys.openai': "string = ''",
'apiKeys.anthropic': "string = ''",
'apiKeys.groq': "string = ''",
// ...9 providers, all in client settings
```

This creates problems:

1. **Env vars are poor UX for local users**: Editing `.env` files or exporting shell variables is a developer workflow, not a user workflow. No settings UI, no hot-reload without server restart (env vars are read at request time, but setting them requires restart or external tooling).
2. **Client-side key storage scatters secrets**: Each app (Whispering, tab-manager, future apps) stores its own copy of API keys. No single source of truth. Keys live in Yjs documents that may sync through relays.
3. **No path to cloud deployment**: A cloud-hosted Epicenter needs per-user key storage with encryption at rest. Env vars don't scale to multi-tenant. Client-sent headers work but require the client to persist keys somewhere.
4. **Two apps, two key management UIs**: Whispering has 9 API key input components. Any new Epicenter app would need to rebuild this. The server should be the single authority.

### Desired State

Any Epicenter client calls the same REST API to manage keys:

```typescript
// Set a key
await fetch(`${serverUrl}/api/provider-keys/openai`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey: 'sk-...' }),
});

// List configured providers
const res = await fetch(`${serverUrl}/api/provider-keys`);
// → { providers: ['openai', 'anthropic'] }

// Chat endpoint resolves key automatically
await fetch(`${serverUrl}/ai/chat`, {
  method: 'POST',
  body: JSON.stringify({ messages: [...], provider: 'openai', model: 'gpt-4o' }),
});
// No x-provider-api-key header needed: server already has it
```

Works identically whether `serverUrl` is `http://localhost:3913` or `https://api.epicenter.so`.

## Research Findings

### Prior Art in This Codebase

Two existing specs explored client-side encryption:

| Spec                             | Approach                              | Encryption                                        | Storage                                             | Status                       |
| -------------------------------- | ------------------------------------- | ------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| `encrypted-api-key-vault.md`     | Zero-knowledge, password-derived keys | Client-side AES-GCM, PBKDF2 from password         | Yjs KV LWW (synced), wrapped master key in Postgres | Draft                        |
| `encrypted-workspace-storage.md` | Value-level encryption for ALL data   | Client-side AES-GCM, key from cloud/password/none | Yjs Y.Doc values                                    | Draft, supersedes vault spec |

**Key finding**: Both specs optimize for zero-knowledge (server can't read keys). This is the right call for sensitive user data like transcriptions and notes. But API keys have a fundamentally different property: **the server needs to read them to call AI providers**. Zero-knowledge encryption for API keys that the server must decrypt to use adds complexity without security benefit.

**Implication**: Server-side storage with server-managed encryption is the correct pattern for API keys specifically. The broader encrypted workspace storage spec remains valuable for other sensitive data.

### How Other Local-First Tools Handle API Keys

| Tool         | Key Storage             | Key Management             |
| ------------ | ----------------------- | -------------------------- |
| Ollama       | N/A (local models)      | N/A                        |
| Jan.ai       | Client-side config file | Settings UI writes to JSON |
| Open WebUI   | Server-side SQLite      | REST API + admin UI        |
| LibreChat    | Server-side (MongoDB)   | REST API + admin panel     |
| Anything LLM | Server-side SQLite      | REST API                   |

**Key finding**: Every self-hosted AI tool with a server component stores API keys server-side. Client-only storage is only used by purely client-side apps.

**Implication**: Server-side storage is the established pattern. The one-to-one API mapping between local and cloud is what Open WebUI and LibreChat already do.

## Design Decisions

| Decision                          | Choice                                                             | Rationale                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage location                  | Server-side (not client, not Yjs)                                  | Server needs plaintext keys to call providers. Client-side storage adds a round-trip and scatters secrets.                                                                                                                                                                                                 |
| Local storage engine              | Versioned JSON file with `Bun.write()` atomic writes               | ~5-10 entries, <2KB total: SQLite is overkill. Full TypeScript type safety. Versioned migration pattern (same as `defineKv`) makes schema evolution trivial. Atomic writes via temp+rename. Easy to inspect (`cat keys.json`). Server config ≠ user data: doesn't belong in workspace Yjs.               |
| Cloud storage engine              | Postgres (via existing Better Auth DB)                             | Standard. Per-user rows. Already in the cloud stack.                                                                                                                                                                                                                                                       |
| Encryption (local)                | AES-256-GCM with auto-generated `master.key` file                  | Protects against partial file leaks (backup sync, accidental git commit). Server generates a random 256-bit key on first boot, stores in `~/.epicenter/server/master.key`. Same machine = attacker needs both files. Zero user friction: fully automatic. See "Local Encryption (Model 2)" section below. |
| Encryption (cloud)                | AES-256-GCM with server-managed key                                | Protects against database breaches. Server key from KMS or env var. Standard SaaS pattern. NOT password-derived: server must decrypt without user present.                                                                                                                                                |
| API key resolution priority       | (1) per-request header → (2) server storage → (3) undefined        | Two sources, not three. Header preserves backward compat. Server storage is the single persistent source. No runtime env var fallback.                                                                                                                                                                     |
| Environment variable handling     | Seed store on startup (insert-if-absent)                           | Env vars are an input mechanism, not a runtime source. On boot, `OPENAI_API_KEY` etc. are read and inserted into the store if no value exists. API-set values survive restarts: env vars only bootstrap.                                                                                                  |
| Auth for key management endpoints | CORS allowlist + bearer token (local), Better Auth session (cloud) | Local server validates Origin header against configurable allowlist (browser clients) and requires bearer token (non-browser clients). See `20260222T200800-server-endpoint-security.md` for full design. Cloud requires Better Auth session.                                                              |
| Sync across devices               | Not via Yjs                                                        | Keys don't sync. Set them once per server. For cloud, keys are on the server: all devices access via authenticated session.                                                                                                                                                                               |

## Architecture

### API Surface

```
PUT    /api/provider-keys/:provider   →  Store/update API key
GET    /api/provider-keys             →  List providers with configured keys
GET    /api/provider-keys/:provider   →  Check if key exists (does NOT return key)
DELETE /api/provider-keys/:provider   →  Remove API key
```

The GET endpoint for a specific provider returns `{ configured: true }`, never the key itself. Keys are write-only from the client's perspective.

### Resolution Chain

```
  POST /ai/chat { provider: 'openai', ... }
          │
          ▼
  ┌─────────────────────────────────────────┐
  │           resolveApiKey()               │
  │                                         │
  │  1. x-provider-api-key header?  ──YES──▶ use it (backward compat)
  │         │ NO                            │
  │  2. Server storage has key?     ──YES──▶ use it (primary path)
  │         │ NO                            │
  │  3. Return undefined ──────────────────▶ 401 error
  │                                         │
  └─────────────────────────────────────────┘
```

Two sources, not three. Environment variables are not checked at request time. They seed the store on server startup (see below).

### Storage Layer (Adapter Pattern)

```
┌──────────────────────────────┐
│     Elysia Route Handlers    │
│  PUT/GET/DELETE /api/...     │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      KeyStore Interface      │
│                              │
│  get(provider): string|null  │
│  set(provider, key): void    │
│  delete(provider): void      │
│  list(): string[]            │
│  has(provider): boolean      │
└──────────────┬───────────────┘
               │
       ┌───────┴────────┐
       ▼                 ▼
┌──────────────┐  ┌──────────────────┐
│  JsonStore   │  │  PostgresStore   │
│ (keys.json)  │  │  (AES-256-GCM)  │
│ AES-256-GCM  │  │  server key from │
│ master.key   │  │  KMS / env var   │
└──────────────┘  └──────────────────┘
```

### Environment Variable Seeding

On server startup, the key store reads known env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) and inserts them into the store **if no value already exists** for that provider. This is insert-if-absent, not upsert: API-set values always survive restarts.

```typescript
// Pseudocode: runs once at server boot
for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
	const value = process.env[envVar];
	if (value && !store.has(provider)) {
		store.set(provider, value, 'env'); // source = 'env'
	}
}
```

**Semantics:**

- Env vars bootstrap the store for Docker/CI workflows (`docker run -e OPENAI_API_KEY=sk-...`).
- Once a user sets a key via the REST API (`source: 'api'`), that value takes precedence: env var won't overwrite it on next restart.
- Deleting a key via the API and restarting will re-seed from the env var (since no value exists anymore). This is intentional: if you want to truly remove a key, unset the env var too.
- The `source` column tracks provenance so the UI can show "Set via environment variable" vs "Set via API".

### JSON Schema (Local)

The local key store is a versioned JSON file. The schema follows the same `_v` discriminant pattern used by `defineTable` and `defineKv` throughout Epicenter: version tag in the data, migration function normalizes on read.

**Version 1:**

```typescript
type KeyStoreV1 = {
	_v: 1;
	providers: Record<
		string,
		{
			ct: string; // AES-256-GCM ciphertext (base64)
			iv: string; // 12-byte IV (base64)
			source: 'api' | 'env';
			updatedAt: number; // Unix timestamp (seconds)
		}
	>;
};
```

**Example on disk** (`~/.epicenter/server/keys.json`):

```json
{
	"_v": 1,
	"providers": {
		"openai": {
			"ct": "a1b2c3d4...",
			"iv": "e5f6a7b8...",
			"source": "api",
			"updatedAt": 1740268800
		},
		"anthropic": {
			"ct": "x9y8z7w6...",
			"iv": "q1r2s3t4...",
			"source": "env",
			"updatedAt": 1740268800
		}
	}
}
```

The `source` field records how the key was stored: `'api'` for keys set via REST endpoints, `'env'` for keys seeded from environment variables. This enables the UI to display provenance and lets the seeding logic skip providers that already have an API-set value.

API keys are encrypted at rest using AES-256-GCM with the auto-generated master key (see below). Each provider entry stores base64-encoded ciphertext and a per-entry 12-byte initialization vector.

**Schema evolution** follows the `defineKv` migration pattern:

```typescript
// Future version: adding a field is version() + migrate(), not ALTER TABLE
type KeyStoreV2 = {
	_v: 2;
	providers: Record<
		string,
		{
			ct: string;
			iv: string;
			source: 'api' | 'env';
			updatedAt: number;
			rotatedAt: number | null; // new field
		}
	>;
};

// Migration normalizes any version to latest on read
function migrate(data: KeyStoreV1 | KeyStoreV2): KeyStoreV2 {
	switch (data._v) {
		case 1:
			return {
				_v: 2,
				providers: Object.fromEntries(
					Object.entries(data.providers).map(([k, v]) => [
						k,
						{ ...v, rotatedAt: null },
					]),
				),
			};
		case 2:
			return data;
	}
}
```

**Why JSON over SQLite**: We're storing ~5-10 entries totaling <2KB. SQLite's advantages (ACID, indexing, complex queries) don't apply: we only need `get(provider)`, `set(provider, key)`, `list()`, `has(provider)`, `delete(provider)`. JSON gives us full type safety, trivial versioned migrations (no `ALTER TABLE`), easy inspection (`cat keys.json`), and consistency with how the rest of Epicenter handles schema evolution. Atomic writes via `Bun.write()` (temp file + rename) provide the same durability guarantee for a single small file.

**When to reconsider SQLite**: If the store grows to include usage tracking, rate limit history, key rotation audit logs, or any data that benefits from querying: that's when SQLite earns its place. For the current scope (a handful of encrypted provider keys), JSON is simpler and more appropriate.

### Local Encryption (Model 2: Auto-Generated Master Key)

On first boot, the server generates a random 256-bit AES key and stores it in a separate file. All API keys in `keys.json` are encrypted with this key. Zero user friction: fully automatic.

**Directory layout:**

```
~/.epicenter/server/
├── keys.json        ← Versioned JSON (encrypted ciphertext + IV per provider)
├── master.key       ← 256-bit AES key (generated on first boot, 32 bytes raw)
└── config.json      ← allowed origins, app API keys, etc.
```

**Why `~/.epicenter/server/`**: Home dotfiles are the convention for developer tools (Claude Code uses `~/.claude/`, Ollama uses `~/.ollama/`, Cursor uses `~/.cursor/`). Discoverable with `ls -la ~`. Distinct from project-local `<project>/.epicenter/` which stores workspace data.

**Key generation (first boot):**

```typescript
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SERVER_DIR = join(homedir(), '.epicenter', 'server');
const MASTER_KEY_PATH = join(SERVER_DIR, 'master.key');

async function getOrCreateMasterKey(): Promise<CryptoKey> {
	await mkdir(SERVER_DIR, { recursive: true });

	if (existsSync(MASTER_KEY_PATH)) {
		const raw = await Bun.file(MASTER_KEY_PATH).arrayBuffer();
		return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
			'encrypt',
			'decrypt',
		]);
	}

	const key = await crypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 },
		true,
		['encrypt', 'decrypt'],
	);
	const raw = await crypto.subtle.exportKey('raw', key);
	await Bun.write(MASTER_KEY_PATH, new Uint8Array(raw));
	return key;
}
```

**Encrypt before storing:**

```typescript
async function encryptApiKey(
	masterKey: CryptoKey,
	plaintext: string,
): Promise<{ ct: string; iv: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encoded = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		masterKey,
		encoded,
	);
	return {
		ct: Buffer.from(ciphertext).toString('base64'),
		iv: Buffer.from(iv).toString('base64'),
	};
}
```

**Decrypt when reading:**

```typescript
async function decryptApiKey(
	masterKey: CryptoKey,
	ct: string,
	iv: string,
): Promise<string> {
	const ciphertext = Buffer.from(ct, 'base64');
	const ivBytes = Buffer.from(iv, 'base64');
	const decrypted = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: ivBytes },
		masterKey,
		ciphertext,
	);
	return new TextDecoder().decode(decrypted);
}
```

**Master key deletion recovery:**

If `master.key` is deleted, the server cannot decrypt existing entries in `keys.json`. On next boot:

1. Server generates a new `master.key`
2. Existing encrypted entries are unreadable (decryption fails gracefully)
3. The corrupted `keys.json` is replaced with an empty store
4. Env var seeding re-populates from environment variables
5. User re-enters any API-set keys via REST API or settings UI
6. No catastrophic data loss: API keys are always recoverable from provider dashboards

**Threat model:**

| Threat                                    | Protected?     | How                                                            |
| ----------------------------------------- | -------------- | -------------------------------------------------------------- |
| `keys.json` leaked via backup/sync/git    | ✅ Yes         | Ciphertext useless without `master.key`                        |
| Attacker reads JSON file but not key file | ✅ Yes         | AES-256-GCM ciphertext is opaque                               |
| Full disk access (malware)                | ❌ No          | Attacker can read both files: app-level encryption can't help |
| `master.key` deleted                      | ✅ Recoverable | New key generated, user re-enters API keys                     |

### Postgres Schema (Cloud)

```sql
CREATE TABLE provider_keys (
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  api_key_ct TEXT NOT NULL,        -- AES-256-GCM ciphertext (base64)
  api_key_iv TEXT NOT NULL,        -- 12-byte IV (base64)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);
```

### Server Config Change

```typescript
// packages/server/src/server.ts
export type ServerConfig = {
  clients: AnyWorkspaceClient[];
  port?: number;
  sync?: { ... };
  // NEW: key store for API key management
  keyStore?: KeyStore;  // defaults to JsonKeyStore if omitted
};
```

### Plugin Structure

```
packages/server/src/
├── ai/
│   ├── plugin.ts          # Chat endpoint (existing, modified resolveApiKey)
│   ├── adapters.ts        # Provider adapters (existing, modified resolveApiKey)
│   └── ...
├── keys/                  # NEW
│   ├── plugin.ts          # Elysia route handlers for /api/provider-keys
│   ├── store.ts           # KeyStore interface + JsonKeyStore
│   ├── store.test.ts      # Unit tests
│   └── index.ts           # Public exports
└── server.ts              # Mounts keys plugin
```

## Implementation Plan

### Phase 1: Local JSON key store + REST API + encryption

This is the minimum viable feature. Local server stores encrypted keys, chat endpoint reads from storage.

- [ ] **1.1** Create master key management: `getOrCreateMasterKey()` using Web Crypto `AES-GCM` (256-bit), stored at `~/.epicenter/server/master.key`
- [ ] **1.2** Create `KeyStore` interface (with `source` parameter on `set`) and `JsonKeyStore` implementation using versioned JSON with AES-256-GCM encryption (ciphertext + IV per entry), atomic writes via `Bun.write()`
- [ ] **1.3** Create Elysia plugin with PUT/GET/DELETE routes for `/api/provider-keys`
- [ ] **1.4** Update `resolveApiKey()` to accept a `KeyStore`: resolution is now header → store → undefined (no env var fallback)
- [ ] **1.5** Implement env var seeding: on `JsonKeyStore` construction, read `PROVIDER_ENV_VARS` and insert-if-absent with `source: 'env'` (encrypted before storage)
- [ ] **1.6** Wire the keys plugin into `createServer()` with optional `keyStore` config
- [ ] **1.7** Graceful handling of master key loss: if decryption fails on read, log warning, replace with empty store (allows re-seeding from env vars or re-entry via API)
- [ ] **1.8** Tests: CRUD operations, encryption round-trip, resolution priority (header > store > undefined), env var seeding (insert-if-absent, API-set values survive restart), master key deletion recovery, JSON version migration

### Phase 2: Chat endpoint integration

- [ ] **2.1** Update `createAIPlugin()` to accept a `KeyStore` (or resolver function)
- [ ] **2.2** Remove hard requirement for `x-provider-api-key` header when store has the key
- [ ] **2.3** Update error messages to mention both key sources (header and server storage)
- [ ] **2.4** Update existing tests

### Phase 3: Client integration (future)

- [ ] **3.1** API key management UI in Epicenter apps (settings page with PUT/DELETE calls)
- [ ] **3.2** Migrate Whispering away from client-side `apiKeys.*` settings toward server calls
- [ ] **3.3** Connection adapter in `@tanstack/ai-svelte` that drops the `x-provider-api-key` header when server has keys

### Phase 4: Cloud deployment (future)

- [ ] **4.1** `PostgresKeyStore` implementation with AES-256-GCM encryption (same interface as `JsonKeyStore`, different backend)
- [ ] **4.2** Auth middleware on key management endpoints (Better Auth session required)
- [ ] **4.3** Server encryption key from KMS or environment variable (replaces auto-generated `master.key`)
- [ ] **4.4** Per-user key isolation (primary key becomes `(user_id, provider)`)

## Edge Cases

### Key update race condition

Two clients PUT the same provider key simultaneously. The JSON store is single-process, so writes are serialized in-memory: last write wins. For local server (single user), this is fine. For cloud (per-user keys), the primary key is `(user_id, provider)` so different users never conflict.

### Server restart

Keys persist in `keys.json`. No data loss. The JSON file survives process restarts.

### Header key vs stored key

If a request includes `x-provider-api-key` AND the store has a key for that provider, the header wins. This is intentional. It allows per-request key override for testing or multi-user scenarios without disturbing stored keys.

### Migration from env vars

Users who currently use `OPENAI_API_KEY` env vars need zero migration. On first server boot with the new key store, env vars are automatically seeded into `keys.json`. Subsequent requests resolve from the store. If the user later sets a key via the API, it overwrites the env-seeded value. If the user deletes via API and restarts, the env var re-seeds.

The only behavioral change: env vars are no longer read at request time. They're read once on startup. For the vast majority of users, this is invisible. The edge case is someone changing an env var without restarting the server: previously this worked (env vars are read per-request), now it doesn't. This is acceptable because "restart server after config change" is the expected workflow.

### Migration from Whispering client-side keys

Whispering stores keys in Yjs KV settings. Migration path: read client-side keys → PUT to server → remove from client settings. This can be a one-time migration prompt or manual.

### JSON file location

Default to a well-known path (`~/.epicenter/server/keys.json`). Configurable via `ServerConfig.dataDir`. The file is NOT inside any workspace directory. It's server config, not user data.

## Open Questions (Resolved)

1. **Key store file location**: ✅ Resolved → `~/.epicenter/server/keys.json`
   - Home dotfile convention matches Claude Code (`~/.claude/`), Ollama (`~/.ollama/`), Cursor (`~/.cursor/`). Discoverable, simple, distinct from project-local `<project>/.epicenter/` workspace data. Override via `ServerConfig.dataDir`.

2. **Local storage engine**: ✅ Resolved → Versioned JSON (not SQLite)
   - ~5-10 entries, <2KB total. Only need Map-like operations (`get`, `set`, `list`, `has`, `delete`). JSON gives full TypeScript type safety, trivial versioned migrations (same `_v` + `migrate()` pattern as `defineKv`), easy inspection, and atomic writes via `Bun.write()`. SQLite's advantages (ACID, indexing, complex queries) don't apply here. Reconsider SQLite if the store grows to include usage tracking or audit logs.

3. **Should the REST API return the key on GET?** ✅ Resolved → Never return key (write-only)
   - Show `{ configured: true, source: 'api' | 'env', updatedAt: ... }` instead.

4. **Should the keys plugin be a separate Elysia sub-entry export?** ✅ Resolved → Part of `@epicenter/server` initially
   - Extract later if it grows.

5. **Platform-provided keys**: Deferred until cloud deployment.

6. **Relationship to existing encrypted vault specs**: ✅ Resolved → Keep both
   - This spec handles API keys (server needs them). The vault spec handles truly sensitive data the server shouldn't see. Different threat models.

7. **Local encryption**: ✅ Resolved → Model 2 (auto-generated `master.key`)
   - Zero user friction. Protects against partial file leaks (backup/sync). Full disk access defeats it, but that's an acceptable tradeoff: OS-level encryption handles that layer.

8. **HTTP endpoint security**: ✅ Resolved → CORS allowlist + bearer token
   - See `20260222T200800-server-endpoint-security.md` for full design.

## Success Criteria

- [ ] `PUT /api/provider-keys/openai` stores an encrypted key at `~/.epicenter/server/keys.json`
- [ ] `POST /ai/chat` with `provider: openai` resolves it without header or env var
- [ ] `GET /api/provider-keys` returns list of configured providers (not key values)
- [ ] Header key still overrides stored key (backward compat)
- [ ] Env var still works when neither header nor store has a key
- [ ] Server restart preserves stored keys (encrypted at rest)
- [ ] Deleting `master.key` and restarting recovers gracefully (env vars re-seed, user re-enters API keys)
- [ ] Raw `keys.json` file contains only ciphertext (verify with `cat keys.json`: no plaintext API keys visible)
- [ ] JSON schema versioning works (old `_v: 1` file migrated to latest version on read)
- [ ] `bun test` in `packages/server` passes
- [ ] No new dependencies beyond Web Crypto API (built-in)

## References

- `packages/server/src/ai/adapters.ts`: Current `resolveApiKey()`, `PROVIDER_ENV_VARS`, `SUPPORTED_PROVIDERS`
- `packages/server/src/ai/plugin.ts`: Chat endpoint that calls `resolveApiKey()`
- `packages/server/src/server.ts`: `createServer()` and `ServerConfig`
- `apps/whispering/src/lib/settings/settings.ts`: Client-side API key storage (9 providers)
- `apps/whispering/src/lib/components/settings/api-key-inputs/`: 9 API key input components
- `specs/20260213T030000-encrypted-api-key-vault.md`: Zero-knowledge vault approach (different tradeoffs)
- `specs/20260213T005300-encrypted-workspace-storage.md`: Value-level Yjs encryption (broader scope)
- `specs/20260220T200100 ai-plugin.md`: Original AI plugin design with `x-provider-api-key` header
