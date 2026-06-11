# Shared Auth Factory for Tab Manager

Migrate `apps/tab-manager/src/lib/state/auth.svelte.ts` (~490 lines) to use
the shared `createAuthState` from `@epicenter/svelte/auth-state`, eliminating
~70% duplicated logic. Honeycrisp, opensidian, and zhongwen already use it.

## Current State

### Shared factory (`packages/svelte-utils/src/auth-state.svelte.ts`)
- Used by: honeycrisp, opensidian, zhongwen
- Storage: raw `localStorage` calls for token, `createPersistedState` for user
- Config: `baseURL`, `storagePrefix`, `signInWithGoogle?`, `onSignedIn?`, `onSignedOut?`
- All storage is synchronous

### Tab manager (`apps/tab-manager/src/lib/state/auth.svelte.ts`)
- Own `createAuthState` factory with ~70% identical logic
- Storage: `createStorageState` (wraps `@wxt-dev/storage` / chrome.storage)
- Extra: form state (`email`, `password`, `name`, `mode`), cross-context watchers, `keyCache`
- Google OAuth via `chrome.identity.launchWebAuthFlow` (already supported via `signInWithGoogle` config override)

## Key Differences to Reconcile

### 1. Storage: sync localStorage vs chrome.storage

**Not actually that different.** `createStorageState` wraps chrome.storage into
a sync `.current` getter/setter backed by `$state`. Reads are synchronous.
Writes are optimistic (sync $state update, async persistence in background).
Same shape as `createPersistedState`.

The one real difference: **initial load**. `createPersistedState` reads
localStorage synchronously on construction. `createStorageState` starts with
a fallback and loads async (`whenReady` promise). Tab manager's `checkSession`
awaits `whenReady` before reading so it doesn't see stale fallback values.

**Fix:** Make the shared factory accept pluggable storage instead of
hardcoding localStorage. Both storage implementations already expose the
Svelte reactive value convention (`.current` getter/setter), so the config
just requires that shape. No wrapper type needed:

```typescript
storage: {
  token: { current: string | undefined };
  user: { current: AuthUser | undefined };
};
```

Both `createPersistedState` and `createStorageState` already satisfy this
via their `.current` getter/setter. For localStorage token, `createLocalStorage`
wraps `getItem`/`setItem` into a `.current` accessor.

Add `whenReady?: Promise<void>` to config. `checkSession` awaits it if present.
Web apps omit it (sync storage, no wait needed).

### 2. Cross-context watchers (extension-only)

Tab manager watches for token/user changes from other extension contexts
(popup, sidebar, background). Two watchers:

- **Token cleared externally** -> clear user, call `onSignedOut`, set phase to `signed-out`
- **User set externally** -> set phase to `signed-in`, restore encryption from `keyCache`

These can't live inside the shared factory because it doesn't know about
`createStorageState.watch()`. Two options:

**Option A: Factory exposes lifecycle methods, consumer wires watchers externally.**

```typescript
// Shared factory returns:
handleExternalSignOut(): void
handleExternalSignIn(): void

// Tab manager wires:
authToken.watch((token) => {
  if (!token && authState.status === 'signed-in') authState.handleExternalSignOut();
});
authUser.watch((user) => {
  if (user && authToken.current && authState.status === 'signed-out') authState.handleExternalSignIn();
});
```

**Option B: Config accepts watcher setup callback.**

```typescript
createAuthState({
  onInit: ({ handleExternalSignOut, handleExternalSignIn }) => {
    authToken.watch((token) => { ... });
    authUser.watch((user) => { ... });
  },
});
```

**Recommendation: Option A.** Simpler, no new config shape, consumer has full
control. The methods are just phase transitions + calling `onSignedOut`/`onSignedIn`.

**Wrinkle:** `handleExternalSignIn` needs to restore encryption from the key
cache, not from the server. The existing `onSignedIn(encryptionKey: string)`
callback expects a key. For external sign-in, there's no key from the server;
it's loaded from `keyCache`.

**Fix:** Add an optional `onExternalSignIn?: () => Promise<void>` callback,
separate from `onSignedIn`. When `handleExternalSignIn` is called, it
transitions to `signed-in` and calls `onExternalSignIn` (which the tab manager
uses to restore from cache). Web apps don't provide it.

### 3. Form state (email, password, name, mode)

Tab manager co-locates form state in the auth singleton. The shared factory
takes explicit params (`signIn({ email, password })`), which is the better
pattern (component owns its own form state).

**Fix:** Move form state to `AuthForm.svelte` as local `$state`. Pass values
to `authState.signIn({ email, password })` and
`authState.signUp({ email, password, name })`.

Tab manager's `signIn()` currently reads from internal state:
```typescript
async signIn() {
  // reads this.email, this.password internally
}
```

After migration, matches the shared factory signature:
```typescript
async signIn(credentials: { email: string; password: string }) {
  // credentials passed explicitly
}
```

### 4. Encryption key handling

- Shared factory: `onSignedIn(encryptionKey: string)` -- consumer does base64 decoding
- Tab manager: calls `workspace.activateEncryption(base64ToBytes(key))` directly

**Already compatible.** Tab manager just passes its encryption logic as `onSignedIn`:
```typescript
createAuthState({
  async onSignedIn(encryptionKey) {
    await workspace.activateEncryption(base64ToBytes(encryptionKey));
  },
  async onSignedOut() {
    await workspace.deactivateEncryption();
  },
});
```

Same pattern as honeycrisp (which already does exactly this).

### 5. Google OAuth

Tab manager implements `chrome.identity.launchWebAuthFlow` inline. The shared
factory already accepts `signInWithGoogle?: () => Promise<AuthUser>`.

**Fix:** Extract tab manager's Google OAuth logic into a standalone function
and pass it as the `signInWithGoogle` config override:

```typescript
createAuthState({
  signInWithGoogle: async () => {
    // chrome.identity.launchWebAuthFlow logic
    // returns AuthUser
  },
});
```

### 6. Reactive `baseURL`

Tab manager wraps `createAuthClient` in `$derived` because the base URL is a
reactive chrome.storage setting (`remoteServerUrl.current`). The shared factory
takes a static `baseURL` string.

**Fix:** Change `baseURL` config to accept `string | (() => string)`. When a
function is passed, the factory calls it lazily in `createAuthClient`'s
`fetchOptions` or wraps the client in `$derived`. Web apps pass a string
(static). Tab manager passes `() => remoteServerUrl.current`.

### 7. `checkSession` differences

Tab manager's `checkSession` has two extra steps vs the shared factory:
1. `await Promise.all([authToken.whenReady, authUser.whenReady])`: wait for chrome.storage
2. Early cache restore: if cached user exists, restore encryption from `keyCache` before server call

**Fix for (1):** Add `whenReady?: Promise<void>` to config. `checkSession`
awaits it if present. One line:

```typescript
async checkSession() {
  if (config.whenReady) await config.whenReady;
  // storage .current is now populated, proceed as normal
}
```

Web apps omit it (sync storage). Tab manager passes it:
```typescript
createAuthState({
  whenReady: Promise.all([authToken.whenReady, authUser.whenReady]),
});
```

**Fix for (2):** Add `onCheckSessionStart?: () => Promise<void>` callback.
Called after `whenReady` resolves but before the server call. Tab manager uses
it to restore encryption from cache for instant startup:

```typescript
createAuthState({
  whenReady: Promise.all([authToken.whenReady, authUser.whenReady]),
  async onCheckSessionStart() {
    const userId = storage.user.current?.id;
    if (userId) {
      const cached = await keyCache.load();
      if (cached) await workspace.activateEncryption(base64ToBytes(cached));
    }
  },
});
```

Web apps don't provide this callback.

## Summary of Changes to Shared Factory

### New config fields

```typescript
type AuthStateConfig = {
  // Existing:
  baseURL: string;
  signInWithGoogle?: () => Promise<AuthUser>;
  onSignedIn?: (encryptionKey: string) => Promise<void>;
  onSignedOut?: () => Promise<void>;

  // Replace storagePrefix with pluggable storage (Svelte .current convention):
  storage: {
    token: { current: string | undefined };
    user: { current: AuthUser | undefined };
  };

  // New:
  /** Resolves when async storage is ready. Omit for sync storage. */
  whenReady?: Promise<void>;
  /** Called at top of checkSession after whenReady, before server call. */
  onCheckSessionStart?: () => Promise<void>;
  /** Called on external sign-in (e.g., another extension context). */
  onExternalSignIn?: () => Promise<void>;
};
```

### New methods on returned object

```typescript
/** Transition to signed-out due to external storage change. */
handleExternalSignOut(): void
/** Transition to signed-in due to external storage change. */
handleExternalSignIn(): void
```

### Backward compatibility

`storagePrefix` is replaced by `storage`. Existing consumers (honeycrisp,
opensidian, zhongwen) need to switch from `storagePrefix` to providing a
`storage` object. Provide a helper:

```typescript
export function createLocalStorage(prefix: string): AuthStateConfig['storage'] {
  const tokenKey = `${prefix}:authToken`;
  const userState = createPersistedState({
    key: `${prefix}:authUser`,
    schema: AuthUser.or('undefined'),
    defaultValue: undefined,
  });
  return {
    token: {
      get current() { return localStorage.getItem(tokenKey) ?? undefined; },
      set current(v: string | undefined) {
        v === undefined
          ? localStorage.removeItem(tokenKey)
          : localStorage.setItem(tokenKey, v);
      },
    },
    user: userState,
  };
}
```

Existing consumers become:
```typescript
export const authState = createAuthState({
  baseURL: APP_URLS.API,
  storage: createLocalStorage('honeycrisp'),
  async onSignedIn(encryptionKey) { ... },
  async onSignedOut() { ... },
});
```

## Tasks

- [x] Add `createLocalStorage` helper to shared factory
- [x] Replace `storagePrefix` + inline localStorage with `storage` config in shared factory
- [x] Add `whenReady` support to `checkSession`
- [x] Add `onCheckSessionStart` callback to `checkSession`
- [x] Add `handleExternalSignOut` / `handleExternalSignIn` methods
- [x] Add `onExternalSignIn` callback to config
- [x] Update honeycrisp to use `createLocalStorage`
- [x] Update opensidian to use `createLocalStorage`
- [x] Update zhongwen to use `createLocalStorage`
- [x] Move form state out of tab manager auth into `AuthForm.svelte`
- [x] Extract tab manager Google OAuth into standalone function
- [x] Migrate tab manager to shared `createAuthState`
- [x] Wire up cross-context watchers in tab manager's auth module
- [x] Delete tab manager's local `AuthPhase` type and duplicate logic
- [x] Verify tab manager builds and auth flow works

## Review

### Implementation Summary

Three commits completed the migration:

1. **refactor(auth): make shared factory pluggable**: Modified shared factory to accept pluggable storage config (`storage: { token, user }` with `.current` getters/setters) instead of hardcoded localStorage + `storagePrefix`. Added `createLocalStorage` helper for web apps. Added new config fields: `whenReady`, `onCheckSessionStart`, `onExternalSignIn`, and support for reactive `baseURL` as `() => string`. Added `handleExternalSignOut` and `handleExternalSignIn` public methods.

2. **refactor(auth): update web apps to use createLocalStorage**: Updated honeycrisp, opensidian, zhongwen to use `createLocalStorage('prefix')` instead of `storagePrefix: 'prefix'`.

3. **refactor(tab-manager): migrate to shared auth factory**: Replaced ~490-line tab-manager auth factory with ~120-line wrapper. Extracted Chrome extension storage (createStorageState) and Google OAuth logic. Moved form state (email, password, name, mode) to AuthForm.svelte as local `$state`. Wired cross-context watchers for external sign-in/out synchronization. Tab-manager builds successfully (1.31 MB total).

### Code reduction

- Tab manager: 488 lines → 130 lines (~73% reduction)
- Shared factory: now serves 4 apps (honeycrisp, opensidian, zhongwen, tab-manager)
- Removed duplicate session validation, phase machine, and token refresh logic

### Architecture

The shared factory now follows a storage adapter pattern:
- Web apps (honeycrisp, opensidian, zhongwen): pass `createLocalStorage('prefix')` → uses localStorage
- Extensions (tab-manager): pass custom `{ token: authToken, user: authUser }` → uses chrome.storage.local via createStorageState

All apps use the same phase machine, Better Auth client, and lifecycle hooks.
