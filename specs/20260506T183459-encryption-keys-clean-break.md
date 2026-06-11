# Encryption keys: one name, one helper, one home

> Identity has one home (`@epicenter/auth`). Workspaces borrow it through one
> name (`encryptionKeys`) and one helper (`requireSignedIn`).
> `@epicenter/auth-workspace` is deleted.

**Date**: 2026-05-06
**Status**: Implemented
**Depends on**: lands on top of `0eb745bc3 chore: migrate remaining workspaces to lazy getKeys`
**Backwards compatibility**: none. Hard rename, hard delete.
**Branch**: feat/encrypted-local-workspace-storage

## One-sentence thesis

```txt
A workspace's only auth dependency is a lazy `encryptionKeys: () => EncryptionKeys`
callback; every other identity check (boundary fail-fast, post-construction
tripwire, browser reload-on-change) is one helper or one inline subscription.
```

## What is wrong now

After the lazy-getKeys migration landed, four cohesion smells remain. Each is a
receipt for an invariant that lives in the wrong place.

```txt
SMELL                                            LOCATION                                          COMPENSATING FOR
──────────────────────────────────────────       ───────────────────────────────────────────      ─────────────────────────────────────────────
1. Verbatim 7-line throw in every daemon/        opensidian/{daemon,script}.ts                     createMachineAuthClient does not assert
   script that opens a workspace                 honeycrisp/{daemon,script}.ts                     signed-in at construction. Each caller
                                                 zhongwen/{daemon,script}.ts                       reinvents requireSignedIn locally.
                                                 fuji/{daemon,script}.ts

2. requireSignedIn lives in @epicenter/          packages/auth-svelte/src/require-signed-in.ts     The helper reads `auth.state` only: it
   auth-svelte but is needed by node-side                                                          has no Svelte dependency. Living in the
   daemons that cannot import auth-svelte                                                          framework package blocks node reuse.

3. The same callback wears two names             attach-encryption.ts: `getKeys`                   The workspace package picked `getKeys`;
   depending on which side of an arbitrary       <app>/index.ts: `getKeys: encryptionKeys`         every app boundary picked `encryptionKeys`
   boundary it is on                              <app>/{browser,extension}.ts: `encryptionKeys`    (matching `bearerToken`). The bridges in
                                                 createSession build:    `encryptionKeys`          <app>/index.ts exist only to rename.

4. @epicenter/auth-workspace is a 99-line        packages/auth-workspace/src/index.ts              The package was designed to push key
   queue/buffer/terminal-flag machine             apps/opensidian/.../client.ts (uses it)          rotation into encryption mid-session.
   wrapping what is now a 5-line                 apps/tab-manager/.../client.ts (uses it)          That mutation hook was deleted last
   onStateChange subscription                                                                      week. The machine that supported it
                                                                                                   stayed.
```

## Ownership test (where each invariant should live)

```txt
INVARIANT                                                              OWNER
─────────────────────────────────────────────────────────────────      ──────────────────────────────────────────
"machine auth has a saved session at boot"                             createMachineAuthClient (throws on null)
"the workspace is alive only while signed-in"                          requireSignedIn(auth) at the lazy boundary
"a different user must reload"                                         createSession (svelte apps) or inline
                                                                       onStateChange (opensidian/tab-manager)
"encryption keys are read at registration time"                        attachEncryption({ encryptionKeys })
"device row's lastSeen refreshes on connection"                        workspace ready hook, not auth events
```

Two layers currently share "the workspace is alive only while signed-in":
the `if (auth.state.status !== 'signed-in') throw` block at every daemon/script
site, plus the type-honesty throw inside `requireSignedIn`. The first is a
boundary check; the second is a tripwire. Both stay; the first collapses to
`requireSignedIn(auth)` once the helper moves to `@epicenter/auth`.

## Asymmetric refusals

### Refusal 1: `getKeys` as a separate name

```txt
Product sentence:
  Pass a lazy callback that returns the user's encryption keys.

Candidate refusal:
  The name `getKeys`. The callback already exists; the issue is that
  `attachEncryption` and `<app>/index.ts` rename to `getKeys` while every
  other boundary in the codebase calls it `encryptionKeys`.

Code family it deletes:
  - `getKeys` field on AttachEncryptionOptions
  - `getKeys: encryptionKeys` rebranding in 4 <app>/index.ts files
  - `getKeys` mentions in attach-encryption.ts JSDoc (4 occurrences)
  - `getKeys` mentions in workspace/README.md
  - `getKeys` references in attach-encryption test file headers

User loss:
  None. Internal-only rename.

Decision:
  Refuse. One name, all the way down.
```

### Refusal 2: `@epicenter/auth-workspace` as a package

```txt
Product sentence:
  When auth state changes meaningfully, the app reloads.

Candidate refusal:
  The bindAuthWorkspaceScope helper.

Code family it deletes:
  - 99-line packages/auth-workspace/src/index.ts (drain queue, terminal
    flag, pendingIdentity buffer, isDraining/isDisposed/isTerminal
    bookkeeping, enterTerminal, processState)
  - packages/auth-workspace/src/index.test.ts
  - packages/auth-workspace/package.json + tsconfig + src tree
  - 4 entries in apps/* package.json dependencies
  - 2 import lines and 2 call sites in opensidian/tab-manager
  - Doc references in:
    - .agents/skills/auth/SKILL.md
    - docs/guides/consuming-epicenter-api.md
    - docs/encryption.md
  - The `applyAuthIdentity()` no-op pattern as a documented thing

User loss:
  None. The lifecycle reduces to a 5-line auth.onStateChange in each
  consuming app. The Svelte apps already use createSession (not the bind
  helper) and need no change.

Decision:
  Refuse. Inline the subscription in opensidian and tab-manager.
```

### Refusal 3: tab-manager registering its device on auth events

```txt
Product sentence:
  The browser extension keeps its device row's `lastSeen` fresh.

Candidate refusal:
  Firing registerDevice from applyAuthIdentity.

Code family it deletes:
  - The misleading hook (auth events have nothing to do with device
    presence; the current binding only worked because applyAuthIdentity
    happened to fire at boot)
  - The dependency on a lifecycle helper that exists for reload, not for
    heartbeat scheduling.

User loss:
  Heartbeat fires once at boot instead of on every applied identity.
  Token refresh no longer triggers a row rewrite. Acceptable: token
  refresh is not user-visible activity.

Decision:
  Refuse. Fire registerDevice once after `tabManager.idb.whenLoaded`. If a
  recurring heartbeat is wanted later, schedule it explicitly (timer or
  sync-reconnect hook), not as a side effect of auth.
```

## Where the boundary check belongs

The user's question: should the throw move into `createMachineAuthClient`?

Yes, partially. There are two distinct moments:

```txt
MOMENT                                                       CHECK
─────────────────────────────────────────────────────        ────────────────────────────────────
Construction. Daemon/script boots, loads keychain.           Throw if no saved session. This is
A null loaded session means the user never logged in.        a real precondition, not paranoia.
                                                             Lives inside createMachineAuthClient.

Post-construction. Long-lived daemon. Server returns         Throw via requireSignedIn(auth)
401 → bearer auth clears tokens → state goes signed-out.     inside the lazy encryptionKeys
The keys callback is called by attach-encryption after       callback. Type-honesty tripwire.
the state has degraded.
```

The construction check is the strong move. It eliminates the verbatim block at
every daemon site. The post-construction tripwire stays as `requireSignedIn`
and is one line.

The third option ("type the return so signed-out becomes impossible") does not
work: `auth.state` is reactive and shared with bearer-auth's refresh logic,
which clears tokens on 401. A type that promises "always signed-in" would be a
lie. Keep the runtime tripwire.

## The new shapes

### `@epicenter/auth` (new owner of `requireSignedIn`)

```ts
// packages/auth/src/require-signed-in.ts (NEW)
import type { AuthClient } from './create-auth.ts';
import type { AuthIdentity } from './types.ts';

export function requireSignedIn(auth: AuthClient): AuthIdentity {
  const state = auth.state;
  if (state.status !== 'signed-in') {
    throw new Error('[auth] called requireSignedIn while not signed-in.');
  }
  return state.identity;
}
```

Re-exported from `packages/auth/src/index.ts`. `packages/auth-svelte/src/require-signed-in.ts` is **deleted** (no re-export shim: clean break).

### `createMachineAuthClient` asserts signed-in at construction

```ts
// packages/auth/src/node/machine-auth.ts
export async function createMachineAuthClient(): Promise<AuthClient> {
  const log = createLogger('machine-auth');
  const { data: loadedSession, error } = await loadMachineSession();
  if (error) throw error;
  if (loadedSession === null) {
    throw new Error(
      '[machine-auth] no saved session in the system keychain. ' +
        'Run `epicenter auth login` first.',
    );
  }
  let currentSession = loadedSession;
  return createBearerAuth({
    baseURL: EPICENTER_API_URL,
    sessionStorage: {
      get: () => currentSession,
      set: async (next) => {
        currentSession = next;
        const { error: saveError } = await saveMachineSession(next);
        if (saveError) log.error(saveError);
      },
    },
  });
}
```

### `attachEncryption` renames `getKeys` → `encryptionKeys`

```ts
// packages/workspace/src/document/attach-encryption.ts
export type AttachEncryptionOptions = {
  /**
   * Lazy reader for the current user's encryption keys. Called synchronously
   * at every attachTable / attachKv / attachIndexedDb site. Throw if no keys
   * are available: a throw here means the workspace outlived its signed-in
   * scope, which is a caller bug.
   */
  encryptionKeys: () => EncryptionKeys;
};

// internal:
store.activateEncryption(deriveKeyring(options.encryptionKeys(), workspaceId));
```

### Daemon/script files lose the throw block

```ts
// apps/opensidian/src/lib/opensidian/daemon.ts (and siblings)
import { createMachineAuthClient, requireSignedIn } from '@epicenter/auth/node';

async start({ projectDir }) {
  const auth = await createMachineAuthClient(); // throws if no saved session
  const doc = openOpensidianDoc({
    clientID: hashClientId(projectDir),
    encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
  });
  // ...
}
```

`requireSignedIn` is exported from `@epicenter/auth` and re-exported from
`@epicenter/auth/node`. **Clean break**: the Svelte apps update imports from
`@epicenter/auth-svelte` to `@epicenter/auth` directly. There is **no
re-export from `@epicenter/auth-svelte`**. One name, one home.

### `examples/notes-cross-peer/notes.ts` is amended too

```ts
// examples/notes-cross-peer/notes.ts:48: already imports createMachineAuthClient
const auth = await createMachineAuthClient(); // now throws if no saved session
```

The example uses the auth client only for `bearerToken`. Running without a
saved keychain session would 401 against sync anyway; failing fast at
construction is the honest behavior. The example's README (or a one-line
top-of-file note) gains an instruction to run `epicenter auth login` first.

### `<app>/index.ts` files become straight passthrough

```ts
// apps/opensidian/src/lib/opensidian/index.ts
export function openOpensidian({
  encryptionKeys,
  clientID,
}: {
  encryptionKeys: () => EncryptionKeys;
  clientID?: number;
}) {
  const ydoc = new Y.Doc({ guid: 'epicenter.opensidian', gc: false });
  if (clientID !== undefined) ydoc.clientID = clientID;
  const encryption = attachEncryption(ydoc, { encryptionKeys });
  const tables = encryption.attachTables(opensidianTables);
  const kv = encryption.attachKv({});
  return { ydoc, tables, kv, encryption /* ... */ };
}
```

(Same shape for honeycrisp/zhongwen/fuji/tab-manager `index.ts`.)

### `apps/opensidian/src/lib/opensidian/client.ts` (no more bind)

```ts
import { requireSignedIn } from '@epicenter/auth';
import {
  BearerSession,
  createBearerAuth,
  waitForAuthState,
} from '@epicenter/auth-svelte';
// ...

const signedInState = await waitForAuthState(auth, (s) => s.status === 'signed-in');
if (signedInState.status !== 'signed-in') {
  throw new Error('Cannot open Opensidian workspace: signed-in auth required.');
}
const userId = signedInState.identity.user.id;

export const opensidian = openOpensidian({
  userId,
  peer: { /* ... */ },
  bearerToken: () => auth.bearerToken,
  encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
});

auth.onStateChange((state) => {
  if (state.status === 'pending') return;
  if (state.status === 'signed-out') return window.location.reload();
  if (state.identity.user.id !== userId) return window.location.reload();
});
```

### `apps/tab-manager/src/lib/tab-manager/client.ts` (no more bind, registerDevice decoupled)

```ts
const signedInState = await waitForAuthState(auth, (s) => s.status === 'signed-in');
const userId = signedInState.identity.user.id;

export const tabManager = await openTabManager({
  userId,
  peer,
  bearerToken: () => auth.bearerToken,
  encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
});

// Heartbeat: fire once when local hydration completes (cold-boot path).
void tabManager.idb.whenLoaded.then(registerDevice);

auth.onStateChange((state) => {
  if (state.status === 'pending') return;
  if (state.status === 'signed-out') return window.location.reload();
  if (state.identity.user.id !== userId) return window.location.reload();
  // Same-user re-auth (warm path: pending → signed-in after token refresh,
  // browser resume from BFCache, etc.). Refresh `lastSeen` without reload.
  void registerDevice();
});
```

`requireSignedIn` is re-exported from `@epicenter/auth-svelte` so apps importing other Svelte helpers from one place still can. (Re-export, not duplicate definition. The source file lives in `@epicenter/auth`.)

## File-tree changes

```txt
DELETE
─────────────────────────────────────────────────────────────────
packages/auth-workspace/                                          (entire package)
packages/auth-svelte/src/require-signed-in.ts                     (moved to auth)
packages/auth-svelte/src/index.ts                                 (drop requireSignedIn re-export line)

ADD
─────────────────────────────────────────────────────────────────
packages/auth/src/require-signed-in.ts                            (new home)

EDIT (call-site sweeps)
─────────────────────────────────────────────────────────────────
packages/auth/src/index.ts                                        export requireSignedIn
packages/auth/src/node.ts                                         re-export requireSignedIn
packages/auth/src/node/machine-auth.ts                            throw on null session
examples/notes-cross-peer/notes.ts                                (no code change; README/comment notes login precondition)
packages/workspace/src/document/attach-encryption.ts              getKeys → encryptionKeys
packages/workspace/src/document/attach-encryption.test.ts         getKeys → encryptionKeys
packages/workspace/README.md                                      getKeys → encryptionKeys
apps/opensidian/src/lib/opensidian/index.ts                       getKeys → encryptionKeys
apps/opensidian/src/lib/opensidian/browser.ts                     drop rename
apps/opensidian/src/lib/opensidian/daemon.ts                      use requireSignedIn
apps/opensidian/src/lib/opensidian/script.ts                      use requireSignedIn
apps/opensidian/src/lib/opensidian/client.ts                      drop bind, inline subscription
apps/tab-manager/src/lib/tab-manager/index.ts                     getKeys → encryptionKeys
apps/tab-manager/src/lib/tab-manager/extension.ts                 drop rename
apps/tab-manager/src/lib/tab-manager/client.ts                    drop bind, decouple registerDevice
apps/honeycrisp/src/routes/(signed-in)/honeycrisp/index.ts        getKeys → encryptionKeys
apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts      drop rename
apps/honeycrisp/src/routes/(signed-in)/honeycrisp/daemon.ts       use requireSignedIn
apps/honeycrisp/src/routes/(signed-in)/honeycrisp/script.ts       use requireSignedIn
apps/honeycrisp/src/lib/session.svelte.ts                         requireSignedIn import: auth-svelte → auth
apps/zhongwen/src/routes/(signed-in)/zhongwen/index.ts            getKeys → encryptionKeys
apps/zhongwen/src/routes/(signed-in)/zhongwen/browser.ts          drop rename
apps/zhongwen/src/routes/(signed-in)/zhongwen/daemon.ts           use requireSignedIn
apps/zhongwen/src/routes/(signed-in)/zhongwen/script.ts           use requireSignedIn
apps/zhongwen/src/lib/session.svelte.ts                           requireSignedIn import: auth-svelte → auth
apps/zhongwen/src/routes/(signed-in)/+page.svelte                 requireSignedIn import: auth-svelte → auth
apps/fuji/src/routes/(signed-in)/fuji/index.ts                    getKeys → encryptionKeys
apps/fuji/src/routes/(signed-in)/fuji/browser.ts                  drop rename
apps/fuji/src/routes/(signed-in)/fuji/daemon.ts                   use requireSignedIn
apps/fuji/src/routes/(signed-in)/fuji/script.ts                   use requireSignedIn
apps/fuji/src/lib/session.svelte.ts                               requireSignedIn import: auth-svelte → auth
playground/opensidian-e2e/epicenter.config.ts                     getKeys → encryptionKeys
playground/tab-manager-e2e/epicenter.config.ts                    getKeys → encryptionKeys
apps/{fuji,honeycrisp,opensidian,tab-manager}/package.json        drop @epicenter/auth-workspace dep (verify each grep first; some entries may be stale)
docs/encryption.md                                                drop bind examples
docs/guides/consuming-epicenter-api.md                            drop bind examples
.agents/skills/auth/SKILL.md                                      drop bind reference
```

## Wave order (build, prove, remove)

```txt
WAVE 1: Move requireSignedIn to @epicenter/auth (clean break, no shim)
  - Create packages/auth/src/require-signed-in.ts (verbatim copy from auth-svelte)
  - Export from packages/auth/src/index.ts
  - Re-export from packages/auth/src/node.ts (one node-shaped surface)
  - Delete packages/auth-svelte/src/require-signed-in.ts
  - Drop the requireSignedIn re-export line from packages/auth-svelte/src/index.ts
  - Sweep every importer to `@epicenter/auth`:
      apps/honeycrisp/src/lib/session.svelte.ts
      apps/zhongwen/src/lib/session.svelte.ts
      apps/zhongwen/src/routes/(signed-in)/+page.svelte
      apps/fuji/src/lib/session.svelte.ts
      apps/opensidian/src/lib/opensidian/client.ts
      apps/tab-manager/src/lib/tab-manager/client.ts
  - Verify: typecheck. `bun run typecheck` clean.

WAVE 2: createMachineAuthClient asserts signed-in at construction
  - Throw on null loaded session with the message above.
  - Verify: typecheck. Run an end-to-end daemon test if available.

WAVE 3: Daemons/scripts use requireSignedIn
  - Replace each verbatim throw block (8 files: 4 apps × {daemon, script})
    with `requireSignedIn(auth)` import.
  - Verify: typecheck.

WAVE 4: Rename getKeys → encryptionKeys in attachEncryption
  - Edit AttachEncryptionOptions field name.
  - Edit body references (4 inside attach-encryption.ts).
  - Edit all attach-encryption.test.ts uses.
  - Edit every <app>/index.ts factory: rename param, drop the
    `getKeys: encryptionKeys` rebrand in browser/extension/script.
  - Edit playground configs.
  - Edit workspace/README.md.
  - Verify: typecheck + run existing tests.

WAVE 5: Inline auth lifecycle in opensidian/tab-manager
  - Replace `bindAuthWorkspaceScope({...})` with the inline
    `auth.onStateChange` block in both apps.
  - Decouple tab-manager's registerDevice:
      a) Fire once on `tabManager.idb.whenLoaded` (cold-boot heartbeat).
      b) Fire `void registerDevice()` inside the same-user signed-in
         branch of the new onStateChange (warm path: token refresh, BFCache
         resume). This preserves the original "lastSeen refreshes when
         auth reconnects" behavior without using a lifecycle helper.
  - Verify: typecheck. Smoke test in browsers (sign-in → sign-out triggers
    reload; identity-change with same user does not; warm re-auth refreshes
    `lastSeen`).

WAVE 6: Drop the package, prove unused, delete
  - For each app in {fuji, honeycrisp, opensidian, tab-manager}:
      grep for `@epicenter/auth-workspace` in source. If zero matches,
      remove the dep from that app's package.json.
      (Fuji and honeycrisp likely have stale entries; verify before
      removing.)
  - Run `bun install` to update the lockfile.
  - grep for `@epicenter/auth-workspace` and `bindAuthWorkspaceScope`
    repo-wide: zero matches outside the package itself.
  - Delete packages/auth-workspace/ entirely.
  - Update docs: encryption.md, consuming-epicenter-api.md, auth skill.
  - Verify: `bun run typecheck` clean across monorepo.
```

## Final-check questions (clean-break checklist)

```txt
Can I explain the new API without saying "or"?
  → "Pass `encryptionKeys: () => keys`. Throw via requireSignedIn." Yes.

Does one layer own each invariant?
  → "machine auth at boot": createMachineAuthClient.
    "signed-in at lazy read": requireSignedIn.
    "different user reloads": createSession (svelte) / inline (browser/ext).
    Yes.

Would a new caller find only one obvious path?
  → encryptionKeys is the only callback name. requireSignedIn is the only
    helper. There is no second package for lifecycle binding. Yes.

Are examples free of compatibility shapes?
  → No more `getKeys`, no more bindAuthWorkspaceScope. Docs update in W6.

Are side effects injected as policy instead of imported as hidden globals?
  → `() => requireSignedIn(auth).encryptionKeys` injects the callback.
    Reload is policy in the consuming app. Yes.

Did I move the boundary that caused the smell, or only wrap it?
  → createMachineAuthClient now owns the construction invariant; daemons
    no longer reinvent it. Boundary moved.

Did I delete stale names instead of leaving aliases?
  → `getKeys` deleted. bindAuthWorkspaceScope deleted. The auth-workspace
    package deleted. requireSignedIn moved (not duplicated).

Did the file tree change to match the new ownership?
  → Yes: require-signed-in.ts moves; auth-workspace/ disappears.

Did every validation move to the earliest layer that can know the truth?
  → Construction check inside createMachineAuthClient is the earliest
    point a node-side caller can fail; lazy throw at the workspace
    boundary covers the rare post-construction case.

Would mentally inlining each new helper make the code clearer?
  → requireSignedIn could be inlined (it's 4 lines), but it appears at
    14+ call sites and earns its name. Keep.

Did I run the asymmetric wins pass before adding another invariant?
  → Yes. Three refusals documented above.
```

## Out of scope

- Future encryption key rotation. Sync can read refreshed bearer tokens on
  reconnect or request, but already-attached encrypted stores keep the keyring
  they derived when they were attached. Same-user key rotation needs a
  re-attach policy if we want it to affect live stores.
- Wiping IDB on sign-out. Separate concern, separate spec.
- Token-refresh re-registration heartbeat for tab-manager. If wanted, wire
  to sync.onReconnect explicitly; do not piggyback on auth events.
- @epicenter/auth-svelte re-export of requireSignedIn was considered and
  **refused**. The user's clean-break stance ("no compatibility shapes")
  outweighs the small import-line ergonomic loss. Svelte apps add one
  import line; in exchange, every helper has exactly one home.
