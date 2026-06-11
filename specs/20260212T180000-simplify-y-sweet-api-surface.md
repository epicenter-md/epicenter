# Simplify Y-Sweet API Surface

**Status**: Complete (Superseded by `@epicenter/sync` rewrite: PR #1350)

Simplify `AuthEndpoint` and `ClientToken` types in `@epicenter/y-sweet` to remove unused fields, dead code paths, and a URL double-encoding bug. This is a follow-up to the backwards-compatibility removal spec.

> **Note (2026-02-14):** This spec's goals were fully achieved, but not through incremental simplification. The entire `@epicenter/y-sweet` package was deleted and replaced with `@epicenter/sync` (a ground-up rewrite with supervisor loop architecture). All problems identified here: dead `ClientToken` fields, string-branch `AuthEndpoint`, double-docId URL bug, dead `Authorization`/`AuthDocRequest` types: no longer exist. The new `SyncProviderConfig` type takes `url` + `token?` + `getToken?` directly, matching the three auth modes from the server spec.

## Context

After the backwards-compat cleanup, the provider is ~672 lines with a tighter API. But several abstractions still carry baggage from the original Jamsocket SDK that don't match Epicenter's usage:

1. **`AuthEndpoint`** is `string | (() => Promise<ClientToken>)`: the string branch (POST to URL) is never exercised. The extension layer always converts strings to functions before reaching the provider, and direct callers always pass functions. The provider has ~30 lines of dead fetch logic.

2. **`ClientToken`** has 5 fields. Only 2 are functionally used:
   - `baseUrl`: written but never read anywhere in the monorepo
   - `docId`: redundant with the provider's constructor arg, only used in `validateClientToken` and `generateUrl`
   - `authorization`: only triggers a `console.warn`, never set to `'read-only'` anywhere

3. **Double-docId bug**: Direct mode constructs `url` as `ws://host/d/{docId}/ws`, then `generateUrl()` appends `/{docId}` again → `ws://host/d/{docId}/ws/{docId}`. The Y-Sweet server returns `url` as a base (e.g., `ws://host/d/`) expecting the client to append `{docId}`. Direct mode pre-bakes the full path, causing double-encoding.

4. **Dead types**: `AuthDocRequest` and `Authorization` are exported but never imported outside the package.

## Changes

### 1. Simplify `ClientToken` (`types.ts`)

**Before:**

```typescript
export type ClientToken = {
	url: string;
	baseUrl: string;
	docId: string;
	token?: string;
	authorization?: Authorization;
};
export type Authorization = 'full' | 'read-only';
export type AuthDocRequest = {
	authorization?: Authorization;
	userId?: string;
	validForSeconds?: number;
};
```

**After:**

```typescript
export type ClientToken = {
	url: string; // Fully-formed WebSocket URL (docId already in path)
	token?: string; // Optional auth token (appended as ?token=xxx)
};
```

Delete `Authorization` and `AuthDocRequest` types entirely.

The `url` field is now the **fully-formed** WebSocket URL. The provider no longer appends docId. This eliminates the double-encoding bug by design and pushes URL construction to the caller (extension layer), where it belongs.

### 2. Simplify `AuthEndpoint` (`provider.ts`)

**Before:**

```typescript
export type AuthEndpoint = string | (() => Promise<ClientToken>);
```

**After:**

```typescript
export type AuthEndpoint = () => Promise<ClientToken>;
```

### 3. Simplify `getClientToken()` (`provider.ts`)

**Before** (lines 89-121): Two branches: function call vs. fetch POST to string URL.

**After:**

```typescript
async function getClientToken(
	authEndpoint: AuthEndpoint,
): Promise<ClientToken> {
	return authEndpoint();
}
```

Or inline it entirely into `ensureClientToken()`. Remove `validateClientToken()`: no `docId` to validate.

### 4. Simplify `generateUrl()` (`provider.ts`)

**Before** (lines 440-448): Parses URL, appends `/{docId}`, adds token query param.

**After:**

```typescript
private generateUrl(clientToken: ClientToken): string {
    if (!clientToken.token) return clientToken.url;
    const url = new URL(clientToken.url);
    url.searchParams.set('token', clientToken.token);
    return url.toString();
}
```

### 5. Remove `authorization` console.warn (`provider.ts`)

In the `update()` method (current lines 291-297), remove the block that checks `this.clientToken?.authorization === 'read-only'` and logs a warning. Authorization is enforced server-side (the Y-Sweet Rust server blocks `SyncStep2` and `Update` messages for read-only clients).

### 6. Update extension layer (`y-sweet-sync.ts`)

**`YSweetAuthenticatedConfig`:**

```typescript
// Before
authEndpoint: string | (() => Promise<ClientToken>);

// After
authEndpoint: () => Promise<ClientToken>;
```

**`buildAuthEndpoint()`**: simplify, no string-to-function conversion needed:

```typescript
function buildAuthEndpoint(
	config: YSweetSyncConfig,
	docId: string,
): AuthEndpoint {
	switch (config.mode) {
		case 'direct':
			return () =>
				Promise.resolve(createDirectClientToken(config.serverUrl, docId));
		case 'authenticated':
			return config.authEndpoint;
	}
}
```

**Delete `createAuthFetcher()`**: consumers who have a URL can write their own async function. The extension doesn't need to provide fetch logic.

**`createDirectClientToken()`**: return simplified type:

```typescript
function createDirectClientToken(
	serverUrl: string,
	docId: string,
): ClientToken {
	const url = new URL(serverUrl);
	const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return {
		url: `${wsProtocol}//${url.host}/d/${docId}/ws`,
		token: undefined,
	};
}
```

> **Note to implementer:** Verify the WebSocket path format (`/d/{docId}/ws` vs `/{docId}`) against the running Y-Sweet server. The upstream server returns `url` as a base like `ws://host/d/` and expects `{docId}` appended, but the actual WebSocket route may be `/d/{docId}/ws` or just `/{docId}`. Test the connection end-to-end.

### 7. Update app layer (`y-sweet-connection.ts`)

```typescript
// Before
const provider = createYjsProvider(ydoc, workspaceId, async () => ({
	url: `${serverUrl.replace('http', 'ws')}/d/${workspaceId}/ws`,
	baseUrl: serverUrl,
	docId: workspaceId,
	token: undefined,
}));

// After
const provider = createYjsProvider(ydoc, workspaceId, async () => ({
	url: `${serverUrl.replace('http', 'ws')}/d/${workspaceId}/ws`,
	token: undefined,
}));
```

### 8. Clean up exports (`main.ts`)

Remove from exports:

- `AuthDocRequest` type
- `Authorization` type

The remaining public API:

- `createYjsProvider` (function)
- `YSweetProvider` (class)
- `AuthEndpoint` (type)
- `ClientToken` (type)
- `YSweetProviderParams` (type)
- `YSweetStatus` (type)
- `EVENT_CONNECTION_STATUS`, `EVENT_LOCAL_CHANGES` (constants)
- `STATUS_OFFLINE`, `STATUS_CONNECTING`, `STATUS_ERROR`, `STATUS_HANDSHAKING`, `STATUS_CONNECTED` (constants)

## Tasks

- [x] Simplify `ClientToken` in `types.ts`: remove `baseUrl`, `docId`, `authorization`; delete `Authorization` and `AuthDocRequest` types
- [x] Simplify `AuthEndpoint` in `provider.ts`: remove string branch, make it `() => Promise<ClientToken>` only
- [x] Simplify or inline `getClientToken()`: remove string fetch logic and `validateClientToken()`
- [x] Simplify `generateUrl()`: stop appending docId, just append `?token=xxx`
- [x] Remove `authorization` console.warn from `update()` method
- [x] Update `y-sweet-sync.ts`: simplify `YSweetAuthenticatedConfig`, `buildAuthEndpoint()`, delete `createAuthFetcher()`, update `createDirectClientToken()`
- [x] Update `y-sweet-connection.ts`: remove `baseUrl` and `docId` from inline ClientToken
- [x] Remove `AuthDocRequest` and `Authorization` exports from `main.ts`
- [x] Run `bun run check` to verify no type errors (`@epicenter/y-sweet` compiles clean; pre-existing errors in other packages unrelated to this change)
- [x] ~~Test WebSocket connection end-to-end against running Y-Sweet server to verify URL format~~: Superseded: `@epicenter/y-sweet` deleted, replaced by `@epicenter/sync` (PR #1350)

## File summary

| File                                                | Action                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/y-sweet/src/types.ts`                     | Simplify ClientToken, delete Authorization/AuthDocRequest                     |
| `packages/y-sweet/src/provider.ts`                  | Simplify AuthEndpoint, getClientToken, generateUrl, remove authorization warn |
| `packages/y-sweet/src/main.ts`                      | Remove dead type exports                                                      |
| `packages/epicenter/src/extensions/y-sweet-sync.ts` | Simplify config types, delete createAuthFetcher                               |
| `apps/epicenter/src/lib/yjs/y-sweet-connection.ts`  | Remove baseUrl/docId from inline ClientToken                                  |
