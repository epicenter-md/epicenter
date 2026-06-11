# Fix: getToken returning empty string misclassifies auth errors

**Status:** Implemented
**Scope:** 4 files, ~10 lines changed

## Problem

`workspace.ts` line 600:

```typescript
getToken: async () => authState.token ?? '',
```

When a user is not signed in, `authState.token` is `undefined`. The `?? ''` coerces it to an empty string to satisfy `getToken`'s return type (`() => Promise<string>`). The provider then:

1. Calls `getToken()` → gets `''`
2. Checks `if (token)` → `''` is falsy, skips adding `?token=` param
3. Opens WebSocket without auth → server rejects with 401
4. Classifies the failure as `{ type: 'connection' }` instead of `{ type: 'auth' }`
5. Retries with backoff indefinitely

The root cause: `getToken`'s return type is `() => Promise<string>`, which forces callers to return *something* even when no token exists. The type is a lie. Sometimes there genuinely is no token.

## Fix

Make the types honest. Let `getToken` return `string | undefined`. Add a guard in the provider to classify a falsy return as an auth error.

### Changes

**1. `packages/sync-client/src/types.ts`**: Widen return type

```typescript
// Before
getToken?: () => Promise<string>;

// After
getToken?: () => Promise<string | undefined>;
```

**2. `packages/sync-client/src/provider.ts`**: Guard falsy token

After `token = await getToken()`, treat a falsy result as an auth error:

```typescript
token = await getToken();
if (!token) {
    lastError = { type: 'auth', error: new Error('No token available') };
    status.set({ phase: 'connecting', attempt, lastError });
    await backoff.sleep();
    attempt += 1;
    continue;
}
```

No new mutable state. The `let token` already exists on line 234. This is a guard after the existing assignment.

**3. `packages/workspace/src/extensions/sync.ts`**: Widen config type

```typescript
// Before
getToken?: (workspaceId: string) => Promise<string>;

// After
getToken?: (workspaceId: string) => Promise<string | undefined>;
```

**4. `apps/tab-manager/src/lib/workspace.ts`**: Remove the hack

```typescript
// Before
getToken: async () => authState.token ?? '',

// After
getToken: async () => authState.token,
```

### What this does NOT change

- The provider still retries on auth errors (with backoff). This is fine. The user might sign in while the provider is retrying, and `getToken` is called fresh each iteration.
- The UI already checks `lastError?.type === 'auth'` in the tooltip. Correct classification means the UI now shows "Authentication failed" instead of treating it as a generic connection problem.
- The `reconnectSync()` call from `onExternalSignIn()` still handles the sign-in→reconnect flow. The retry loop is a fallback, not the primary recovery path.

### Future consideration (not in scope)

The provider could stop retrying entirely on auth errors and wait for an explicit `reconnect()`. This would eliminate the wasteful polling for unauthenticated users. But at 30s max backoff for a browser extension sidebar, the cost is negligible. Separate concern, separate PR.

## Todo

- [x] Write spec
- [x] Update `SyncProviderConfig.getToken` return type
- [x] Add falsy token guard in provider `runLoop`
- [x] Update `SyncExtensionConfig.getToken` return type
- [x] Remove `?? ''` from workspace.ts callsite
- [x] LSP diagnostics clean on all 4 files
