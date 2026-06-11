# Collapse `@epicenter/oauth-client` into `@epicenter/auth/oauth-launchers`

**Date**: 2026-05-14
**Status**: Implemented
**Author**: Braden + Claude

## Sentence

```txt
The 323-line oauth-client package becomes a subpath of @epicenter/auth,
the same way /node already isolates Bun-only auth code, so browser apps
import one auth package instead of stitching two together.
```

## Motivation

`packages/oauth-client` exists, but it does not earn a separate workspace
package. It is one source file. It pairs 1:1 with `createOAuthAppAuth` in
`@epicenter/auth`. It duplicates the `OAuthTokenGrant` type that
`auth-types` already owns. And every browser/extension consumer imports
from both packages and stitches them together at the call site.

```ts
// Before: every consumer imports from two packages.
import { OAuthSession } from '@epicenter/auth';
import { createOAuthAppAuth } from '@epicenter/auth-svelte';
import {
  createBrowserOAuthLauncher,
  createStorageAdapter,
} from '@epicenter/oauth-client';
```

The boundary the package draws (client OAuth ceremony vs. signed-in
session lifecycle) is real, but it lives perfectly well as a subpath
inside `@epicenter/auth`: the same way `@epicenter/auth/node` already
isolates Bun-only code from browser bundles.

### What the package actually contained

```txt
packages/oauth-client/src/index.ts   ~323 LOC
  createOAuthClient            PKCE/state ceremony via oauth4webapi
                                discovery, auth URL, callback validation,
                                code -> token exchange (security-critical)
  createBrowserOAuthLauncher   ~25 LOC adapter
                                redirects via window.location
  createExtensionOAuthLauncher ~20 LOC adapter
                                wraps chrome.identity.launchWebAuthFlow
  createStorageAdapter         ~7 LOC Storage -> OAuthTemporaryStorage
  OAuthTokenGrant              duplicate of @epicenter/auth's type
```

### Consumers (7)

```txt
apps/fuji          createBrowserOAuthLauncher + createStorageAdapter
apps/honeycrisp    createBrowserOAuthLauncher + createStorageAdapter
apps/opensidian    createBrowserOAuthLauncher + createStorageAdapter
apps/zhongwen      createBrowserOAuthLauncher + createStorageAdapter
apps/dashboard     createBrowserOAuthLauncher + createStorageAdapter
apps/tab-manager   createExtensionOAuthLauncher
packages/cli       device-code flow via better-auth/client/plugins
                   (does NOT import oauth-client)
```

The CLI/node path uses Better Auth's `deviceAuthorizationClient` plugin,
not PKCE redirect. So the "future native runtime" the package's README
hints at does not consume oauth-client today.

## What this does NOT do

`oauth4webapi` stays. No PKCE, state, or token-exchange code is
rewritten. Better Auth's `@better-auth/oauth-provider/client` plugin is
just a fetch hook on top of the Better Auth SDK; it is not a substitute
for the authorization-code ceremony.

Server side is untouched. `apps/api/src/auth/create-auth.ts` keeps
`oauthProvider`. `apps/api/src/auth/resource-boundary.ts` keeps
`oauthProviderResourceClient` and the audience/scope checks.

`createOAuthAppAuth` keeps owning OAuthSession, `/workspace-identity`,
refresh, revoke, `auth.fetch`, and `auth.openWebSocket`. The launcher
layer stays a thin `startSignIn(): Promise<Result<OAuthTokenGrant | null, unknown>>`
adapter.

## Refactor plan

```diff
 packages/auth/
   package.json
+    "./oauth-launchers": "./src/oauth-launchers/index.ts"
+    "oauth4webapi": "catalog:"
   tsconfig.json
+    "lib": ["ESNext", "DOM", "DOM.Iterable"]   # for window.location
   src/
+    oauth-launchers/
+      index.ts         (moved from packages/oauth-client/src/index.ts)
+      index.test.ts    (moved verbatim)
     auth-types.ts      (canonical OAuthTokenGrant lives here already)
-packages/oauth-client/   (deleted)
```

### Type collapse

`packages/oauth-client/src/index.ts` declared its own
`OAuthTokenGrant`. Drop it. Import the canonical one from `auth-types`:

```ts
// Before, inside oauth-client/index.ts
export type OAuthTokenGrant = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
};

// After, inside auth/oauth-launchers/index.ts
import type { OAuthTokenGrant } from '../auth-types.js';
```

`@epicenter/auth` already re-exports `OAuthTokenGrant` from its index, so
the public surface stays the same.

### Consumer import rewrite

Six call sites change one import path each:

```diff
-import {
-  createBrowserOAuthLauncher,
-  createStorageAdapter,
-} from '@epicenter/oauth-client';
+import {
+  createBrowserOAuthLauncher,
+  createStorageAdapter,
+} from '@epicenter/auth/oauth-launchers';
```

Files touched:

```
apps/fuji/src/lib/platform/auth/auth.ts
apps/honeycrisp/src/lib/platform/auth/auth.ts
apps/opensidian/src/lib/platform/auth/auth.ts
apps/zhongwen/src/lib/platform/auth/auth.ts
apps/dashboard/src/lib/platform/auth/auth.ts
apps/tab-manager/src/lib/platform/auth/auth.ts
```

Two consumer package.json files drop the now-dead workspace dep:

```diff
 apps/opensidian/package.json
-  "@epicenter/oauth-client": "workspace:*"
 apps/tab-manager/package.json
-  "@epicenter/oauth-client": "workspace:*"
```

Both still depend on `@epicenter/auth` directly, so the subpath resolves.

### Bundle isolation

The same way the existing `/node` subpath keeps Bun-only code out of
browser bundles, the new `/oauth-launchers` subpath keeps
`oauth4webapi` out of CLI bundles. Tree-shaking is by import-path, not
by tag.

```txt
@epicenter/auth                 -> core: types, session, fetch, ws
@epicenter/auth/node            -> Bun-only: machine-auth, device flow
@epicenter/auth/node/machine-*  -> finer Bun subpaths
@epicenter/auth/oauth-launchers -> browser/extension PKCE ceremony
```

`packages/cli` only imports `@epicenter/auth/node` and friends. It
never reaches `/oauth-launchers`, so `oauth4webapi` is not pulled in.

### tsconfig lib

Moving the launchers means `window.location.href` lives inside
`@epicenter/auth`. The auth tsconfig adds `DOM` and `DOM.Iterable` to
`lib`. This matches the launcher's runtime: browser apps and the
extension. Node-side files under `/node` continue to type-check against
the same lib without depending on it.

## Won't be collapsed (invariants)

1. Server-side `@better-auth/oauth-provider` config and resource-client
   verification stay in `apps/api`. They are not touched.
2. `oauth4webapi` is the primitive. No hand-written PKCE replacement.
3. `OAuthSession` refresh/fetch/WebSocket stays in
   `create-oauth-app-auth.ts`. The launcher layer continues to return
   `Result<OAuthTokenGrant | null, unknown>` and nothing more.

## Risk

Low. Mechanical file move plus six import-path rewrites. The launcher
contract (`OAuthSignInLauncher`) is duck-typed inside
`create-oauth-app-auth.ts`, so the moved factories still satisfy it
without code change. The existing 316-LOC test suite for OAuth ceremony
moves with the source and continues to validate behavior.

## Out of scope

- Future native/loopback launcher (when it lands, it co-locates as
  `oauth-launchers/native.ts` next to the existing two).
- Any change to `auth-svelte`'s re-exports. It still re-exports the same
  types and `createOAuthAppAuth`.
