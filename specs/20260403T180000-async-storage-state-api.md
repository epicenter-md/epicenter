# Storage State API: add `.get()` for imperative reads

**Date**: 2026-04-03
**Status**: In Progress (`.get()` added, remaining call sites tracked)
**Author**: AI-assisted (conversation with Braden)
**Branch**: (new branch from `main` after encryption simplification merges)

## Overview

Split the reactive storage state read API into two explicit channels: `.snapshot` for reactive template reads (always available, may be fallback) and `.get(): Promise<T>` for authoritative reads (awaitable, guaranteed real). This prevents a class of bug where async-backed stores (chrome.storage) look synchronous but silently return stale fallback values.

## Motivation

### Current State

Two factories create reactive state backed by different storage:

```typescript
// packages/svelte-utils: sync (localStorage)
export function createPersistedState<T>({ key, schema, defaultValue }) {
    // localStorage.getItem() is sync → value is real immediately
    let value = $state(readFromLocalStorage(key) ?? defaultValue);
    return {
        get current() { return value; },
        set current(v) { value = v; writeToLocalStorage(key, v); },
    };
}

// apps/tab-manager: async (chrome.storage)
export function createStorageState<T>(key, { fallback, schema }) {
    let value = $state(fallback);  // ← starts as fallback, NOT real value
    const whenReady = item.getValue().then(v => { value = v; });
    return {
        get current() { return value; },  // ← lies before whenReady
        set current(v) { value = v; writeToStorage(v); },
        whenReady,
    };
}
```

Both expose `.current` with the same API shape. But `.current` means different things:

| | `createPersistedState` | `createStorageState` |
|---|---|---|
| `.current` at import time | Real value (localStorage is sync) | **Fallback** (chrome.storage is async) |
| `.current` after init | Real value | Real value |
| Honest? | ✓ | ✗: looks real, isn't |

This caused a real bug: boot code reading `authSession.current?.encryptionKeys` got `null` in the Chrome extension because chrome.storage hadn't loaded yet. The same code worked fine in SvelteKit apps (localStorage is sync).

### The Bug Pattern

```typescript
// Works in SvelteKit (localStorage: sync)
if (session.current?.encryptionKeys) {
    workspace.applyEncryptionKeys(session.current.encryptionKeys);
}

// Silent no-op in Chrome extension (chrome.storage: async)
if (authSession.current?.encryptionKeys) {  // ← always null at import time
    workspace.applyEncryptionKeys(authSession.current.encryptionKeys);  // ← never runs
}
```

The same bug pattern exists in `getToken`:
```typescript
getToken: async () => authSession.current?.token ?? null
// If sync extension connects before whenReady, token is null
```

### Desired State

```typescript
// Boot code: guaranteed real value
const session = await authSession.get();
if (session?.encryptionKeys) {
    workspace.applyEncryptionKeys(session.encryptionKeys);
}

// Template code: reactive snapshot (fine to be fallback briefly)
<p>{authSession.snapshot?.user?.name ?? 'Loading...'}</p>

// Async closures: guaranteed real value
getToken: async () => (await authSession.get())?.token ?? null
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Reactive read name | `.snapshot` | Communicates "point-in-time capture, may be stale." `.current` implies "the real value right now" which is misleading for async stores. |
| Authoritative read | `.get(): Promise<T>` | Standard async read pattern. Sync stores resolve immediately. Async stores wait for load. |
| Write API | `.snapshot = value` (setter) | Consistent with current `.current = value` pattern. Optimistic write: updates reactive state immediately, persists async. |
| Awaitable write | `.set(value): Promise<void>` | Keep existing `set()` method for when callers need write confirmation. |
| `createPersistedState` changes | Add `.get()` returning `Promise.resolve(snapshot)` | Unified API across both factories. Sync stores satisfy `.get()` immediately. |
| `.current` migration | Deprecate, then remove | Keep as alias during migration. Grep and remove once all call sites updated. |
| `whenReady` | Keep | Still useful for "wait for all state to load" patterns. `.get()` is per-value; `whenReady` is per-store. |

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Unified Storage State API                           │
│                                                      │
│  .snapshot        → T          (reactive, immediate) │
│  .snapshot = val  → void       (optimistic write)    │
│  .get()           → Promise<T> (authoritative read)  │
│  .set(val)        → Promise<void> (confirmed write)  │
│  .whenReady       → Promise<void> (load complete)    │
│  .watch(cb)       → () => void (external changes)    │
└──────────────────────────────────────────────────────┘
         ▲                           ▲
         │                           │
   ┌─────┴──────┐            ┌──────┴───────┐
   │ localStorage│            │ chrome.storage│
   │ (sync)      │            │ (async)       │
   │             │            │               │
   │ .get() =    │            │ .get() =      │
   │ Promise     │            │ whenReady     │
   │  .resolve() │            │  .then(read)  │
   └─────────────┘            └───────────────┘
```

## Implementation Plan

### Phase 1: Update `createStorageState` (tab-manager internal)

- [ ] **1.1** Rename `.current` getter to `.snapshot` in `storage-state.svelte.ts`
- [ ] **1.2** Add `.get(): Promise<T>`: waits for `whenReady`, then returns `value`
- [ ] **1.3** Keep `.current` as deprecated alias to `.snapshot` (temporary)
- [ ] **1.4** Update all `createStorageState` consumers in tab-manager:

| File | `.current` usage | Fix |
|---|---|---|
| `client.ts:40-41` | `authSession.current?.encryptionKeys` (boot) | `await authSession.get()` |
| `client.ts:46` | `remoteServerUrl.current` (URL factory) | `.snapshot` (reactive, fine) |
| `client.ts:106` | `serverUrl.current` (URL factory) | `.snapshot` (reactive, fine) |
| `client.ts:107` | `authSession.current?.token` (getToken) | `(await authSession.get())?.token` |
| `chat-state.svelte.ts:146` | `remoteServerUrl.current` (URL template) | `.snapshot` (reactive) |
| `chat-state.svelte.ts:533` | `remoteServerUrl.current` (billing URL) | `.snapshot` (reactive) |
| `settings.svelte.ts` | Usage in JSDoc examples | Update examples |
| `SyncStatusIndicator.svelte` | `syncStatus.current` (template) | `.snapshot` (reactive) |
| `state/auth.ts` | JSDoc references | Update |

- [ ] **1.5** Remove deprecated `.current` alias once all call sites updated

### Phase 2: Update `createPersistedState` (shared library)

- [ ] **2.1** Rename `.current` getter/setter to `.snapshot` in `persisted-state.svelte.ts`
- [ ] **2.2** Add `.get(): Promise<T>` that returns `Promise.resolve(snapshot)`
- [ ] **2.3** Keep `.current` as deprecated alias (temporary)
- [ ] **2.4** Update `create-auth.svelte.ts`: all `session.current` references:

| Line | Usage | Fix |
|---|---|---|
| 290 | `token: () => session.current?.token` (BA fetch auth) | `session.snapshot?.token`: reactive closure, OK |
| 299 | `if (newToken && session.current !== null)` | `session.snapshot !== null` |
| 300 | `session.current = { ...session.current, token: newToken }` | `session.snapshot = { ...session.snapshot, token: newToken }` |
| 309 | `const prev = session.current` | `session.snapshot` |
| 314 | `session.current = { token, user, encryptionKeys }` | `session.snapshot = { ... }` |
| 321 | `session.current = null` | `session.snapshot = null` |
| 330 | `return session.current !== null` | `session.snapshot !== null` |
| 334 | `return session.current?.user ?? null` | `session.snapshot?.user ?? null` |
| 338 | `return session.current?.token ?? null` | `session.snapshot?.token` |
| 420 | `const token = session.current?.token` | `session.snapshot?.token` |

- [ ] **2.5** Update app auth files (honeycrisp, opensidian, zhongwen): no code changes needed (they just create the state), but JSDoc examples may reference `.current`
- [ ] **2.6** Update app client.ts boot code (honeycrisp, opensidian, zhongwen):

```typescript
// Before:
if (session.current?.encryptionKeys) {
    workspace.applyEncryptionKeys(session.current.encryptionKeys);
}

// After (for sync stores, .get() resolves immediately, but consistency is the point):
const cached = await session.get();
if (cached?.encryptionKeys) {
    workspace.applyEncryptionKeys(cached.encryptionKeys);
}
```

Note: for SvelteKit apps with sync localStorage, this `await` resolves on the same tick. The benefit is API consistency. The same boot pattern works regardless of storage backend.

- [ ] **2.7** Remove deprecated `.current` alias

### Phase 3: Update Svelte templates

- [ ] **3.1** Grep all `.svelte` files for `.current` usage on storage state instances
- [ ] **3.2** Replace with `.snapshot` in templates (these are all reactive reads: fine)
- [ ] **3.3** Any `.current` in `$derived` or `$effect` blocks → `.snapshot`

### Phase 4: Update Whispering (if applicable)

- [ ] **4.1** Check `apps/whispering/src/lib/services/desktop/recorder/ffmpeg.ts`: uses `createPersistedState` for `sessionState`. Update `.current` → `.snapshot`

## Edge Cases

### Cold start: no cached session, first-ever login

1. `authSession.get()` resolves with `null` (no cached session)
2. Boot code skips `applyEncryptionKeys` (correct)
3. Auth roundtrip completes → `onLogin` fires → `applyEncryptionKeys` called
4. Data becomes readable

No change from current behavior.

### Offline after first login

1. `authSession.get()` resolves with `{ token, user, encryptionKeys }` from cache
2. Boot code applies cached keys → data readable immediately
3. Auth roundtrip fails (offline) → no `onLogin` → no-op (cached keys still active)

Works correctly.

### Template reads before load (async stores)

1. Template reads `authSession.snapshot?.user?.name` → `undefined` (fallback is null)
2. Template renders loading/fallback state
3. `whenReady` resolves → `snapshot` updates reactively → template re-renders

This is the correct Svelte pattern: reactive state drives UI updates.

### `getToken` closure timing

```typescript
getToken: async () => (await authSession.get())?.token ?? null
```

The `await` ensures the token is real when the closure is called. If auth hasn't loaded yet, it waits (~1-5ms for chrome.storage). This is correct: sync extensions should wait for a real token before attempting authenticated connections.

### `getToken` closures: sync vs async stores

The SvelteKit apps (honeycrisp, opensidian) use `getToken: async () => auth.token`, which reads through `createAuth`'s getter → `session.snapshot?.token`. Since `session` is `createPersistedState` (localStorage, sync), the token is real at call time. **Do not change these**: the indirection through `auth.token` is safe.

The tab-manager reads `authSession.current?.token` directly from a `createStorageState` (chrome.storage, async) instance. This MUST change to `(await authSession.get())?.token` to avoid null tokens before chrome.storage loads.

## Open Questions

1. **Should SvelteKit boot code also use `await session.get()` or stick with sync `.snapshot`?**
   - For localStorage-backed stores, `.snapshot` is already real at import time
   - Using `await session.get()` is a no-op but makes the pattern consistent
   - **Recommendation**: Use `await session.get()` everywhere for consistency. The `await` on a resolved Promise is negligible.

2. **Should `.snapshot` be writable or read-only?**
   - Currently `.current` is both readable and writable (optimistic write)
   - `.snapshot = value` as a setter is slightly odd semantically ("set a snapshot"?)
   - Alternative: make `.snapshot` read-only, keep `.set()` as the only write path
   - **Recommendation**: Keep `.snapshot` writable for Svelte bind compatibility (`bind:value={settings.snapshot}`). The optimistic-write semantics are useful.

3. **Should `createPersistedState` also expose `whenReady`?**
   - Currently only `createStorageState` has it
   - For localStorage, it would be a pre-resolved Promise
   - **Recommendation**: Yes: unified API surface. `whenReady` is always `Promise<void>` regardless of backend.

## Success Criteria

- [ ] Zero `.current` references on storage state objects (grep clean)
- [ ] All boot/init code uses `await .get()` instead of `.snapshot` checks
- [ ] All template code uses `.snapshot` for reactive reads
- [ ] `createPersistedState` and `createStorageState` expose the same API shape
- [ ] Tab-manager `getToken` awaits `authSession.get()` instead of reading `.current`
- [ ] Existing tests pass
- [ ] Type-check passes across monorepo

## References

- `packages/svelte-utils/src/persisted-state.svelte.ts`: `createPersistedState` (to update)
- `apps/tab-manager/src/lib/state/storage-state.svelte.ts`: `createStorageState` (to update)
- `packages/svelte-utils/src/auth/create-auth.svelte.ts`: Auth client (many `.current` refs)
- `apps/tab-manager/src/lib/client.ts`: Boot code that triggered this spec
- `apps/tab-manager/src/lib/chat/chat-state.svelte.ts`: URL reads from storage state
- `apps/tab-manager/src/lib/state/settings.svelte.ts`: `serverUrl`, `remoteServerUrl`
- `apps/honeycrisp/src/lib/client.ts`: Boot code (sync, but should match pattern)
- `apps/opensidian/src/lib/client.ts`: Boot code (sync)
- `apps/zhongwen/src/lib/client.ts`: Boot code (sync)
- `apps/whispering/src/lib/services/desktop/recorder/ffmpeg.ts`: Uses `createPersistedState`

## File Impact Summary

| File | Changes |
|---|---|
| `packages/svelte-utils/src/persisted-state.svelte.ts` | Rename `.current` → `.snapshot`, add `.get()`, add `whenReady` |
| `apps/tab-manager/src/lib/state/storage-state.svelte.ts` | Rename `.current` → `.snapshot`, add `.get()` |
| `packages/svelte-utils/src/auth/create-auth.svelte.ts` | ~10 `.current` → `.snapshot` |
| `apps/tab-manager/src/lib/client.ts` | Boot: `await authSession.get()`, getToken: `await authSession.get()` |
| `apps/honeycrisp/src/lib/client.ts` | Boot: `await session.get()` |
| `apps/opensidian/src/lib/client.ts` | Boot: `await session.get()` |
| `apps/zhongwen/src/lib/client.ts` | Boot: `await session.get()` |
| `apps/tab-manager/src/lib/chat/chat-state.svelte.ts` | `.current` → `.snapshot` (2 sites) |
| `apps/tab-manager/src/lib/state/settings.svelte.ts` | JSDoc updates |
| `apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte` | `.current` → `.snapshot` (5 sites) |
| `apps/whispering/src/lib/services/desktop/recorder/ffmpeg.ts` | `.current` → `.snapshot` |
