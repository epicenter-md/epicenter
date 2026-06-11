# Auth surface collapse audit (post-OOB)

**Date**: 2026-05-15
**Status**: Audit in progress
**Scope**:
- `packages/auth/` (all sources)
- `packages/cli/src/commands/auth.ts`
- `apps/api/src/auth/` and `apps/api/src/auth-pages/`
- `apps/api/src/app.ts` (auth-touching routes only)
- `packages/constants/src/oauth.ts`
**Governing specs**:
- `specs/20260514T120000-machine-auth-oob-clean-break.md`
- `specs/20260514T200000-api-me-three-field-token-bundle.md`
- `specs/20260514T210000-execute-oob-cli-phases-3-4.md`
- `specs/20260514T210000-profile-as-application-data.md`

## One sentence

> The auth surface is mostly settled after the OOB and profile-as-application-data waves, but a handful of duplicate entry points, a dead /api/health route, and a re-declared launcher type are residual smells worth one cohesive cleanup pass.

## Git history feeding this audit

```
99943680f fix(auth): type normalized fetch input for workers
98b103d1a chore: apply formatting
6f15a2c72 fix(auth): clear sign-out before revoke
f2f04c763 test(auth): cover OOB launcher and machine-auth flow
3c5c875e2 feat(cli): wire epicenter auth to OOB flow
51efc2853 feat(auth): replace machine-auth stub with OOB + /api/me flow
095ed0833 feat(auth): add OOB OAuth launcher for CLI sign-in
bf86fe5f0 fix(auth): clear profile spec verification blockers
130dba67e refactor(auth): keep profile data out of auth state
fd263eb70 fix(auth): gate network on verified auth cell
713b9c90b fix(auth): reverify profile after grant refresh
e8247e89d refactor(auth): collapse single-flag auth helpers
7a77786ab refactor(auth): remove unreachable profile null branch
42448b716 refactor(auth): skip no-op refresh publish
3eaea3fc7 refactor(auth): drop redundant dispose guard
3b10602b0 chore(auth): delete /workspace-identity legacy route + reconcile docs and spec
d9238fb51 refactor(auth): collapse profileVerified + cellEpoch into reference equality
58a5e9b36 refactor(auth)!: split persisted shape into grant + unlock with network gate
```

## Public-export inventory

### `@epicenter/auth` (`packages/auth/src/index.ts`)

| Export | Kind | Source | Notes |
| --- | --- | --- | --- |
| `AuthClient` | type | `auth-contract.ts` | Consumed by every app's auth client. |
| `AuthState` | type | `auth-contract.ts` | Three variants; capability-only per `profile-as-application-data`. |
| `AuthError` | runtime factory | `auth-errors.ts` | `StartSignInFailed`, `SignOutFailed`, `VerifyIdentityFailed`, `RefreshGrantFailed`. |
| `AuthError` | type | `auth-errors.ts` | `InferErrors<typeof AuthError>` re-export. |
| `AuthUser` | arktype | `auth-types.ts` | `{ id, email }`; asserted at server boundary. |
| `AuthUser` | type | `auth-types.ts` | `typeof AuthUser.infer`. |
| `LocalUnlockBundle` | type | `auth-types.ts` | `{ userId, encryptionKeys }`; arktype is internal. |
| `OAuthTokenGrant` | type | `auth-types.ts` | `{ accessToken, refreshToken, accessTokenExpiresAt }`; arktype is internal. |
| `PersistedAuth` | arktype + type | `auth-types.ts` | Single persisted cell: `{ grant, unlock }`. |
| `AuthFetch` | type | `create-oauth-app-auth.ts` | `(input, init?) => Promise<Response>`. |
| `CreateOAuthAppAuthConfig` | type | `create-oauth-app-auth.ts` | Factory parameter shape. |
| `createOAuthAppAuth` | function | `create-oauth-app-auth.ts` | The library factory. |
| `OAuthSignInLauncher` | type | `create-oauth-app-auth.ts` | `startSignIn(): Promise<Result<OAuthTokenGrant | null, unknown>>`. |
| `PersistedAuthStorage` | type | `create-oauth-app-auth.ts` | `{ get, set }`. |

### `@epicenter/auth/node` (`packages/auth/src/node.ts`)

Re-exports from `node/machine-auth.ts`:

| Export | Kind | Notes |
| --- | --- | --- |
| `createMachineAuthClient` | function | Daemon entrypoint. |
| `loginWithOob` | function | CLI sign-in. |
| `logout` | function | CLI sign-out. |
| `status` | function | CLI status. |
| `LoginWithOobConfig` | type | Optional config. |
| `LoginWithOobResult` | type | `{ identity: WorkspaceIdentity }`. |
| `LogoutResult` | type | Union of `signedOut` / `loggedOut`. |
| `StatusResult` | type | Union of `signedOut` / `valid` / `unverified`. |
| `MachineAuthRequestError` | runtime factory + type | One variant: `RequestFailed`. |
| `WorkspaceIdentity` | type | `{ user: { id, email }, encryptionKeys }`. |

Re-exports from `node/machine-tokens-store.ts`:

| Export | Kind | Notes |
| --- | --- | --- |
| `loadMachineTokens` | function | File-backed read. |
| `saveMachineTokens` | function | Atomic write. |
| `MachineAuthStorageError` | runtime factory + type | `StorageFailed`, `PermissionsTooOpen`. |

Re-exports from `node/oob-launcher.ts`:

| Export | Kind | Notes |
| --- | --- | --- |
| `createOobOAuthLauncher` | function | OAuth dance. |
| `CreateOobOAuthLauncherConfig` | type | Factory config. |
| `OobLauncherError` | runtime factory + type | `TokenExchangeFailed`, `InvalidTokenResponse`, `AuthorizationCancelled`. |

### `@epicenter/auth/node/machine-auth`

Same module, exported under a second subpath. One caller: `packages/cli/src/commands/auth.ts:14`.

### `@epicenter/auth/oauth-launchers` (`packages/auth/src/oauth-launchers/index.ts`)

| Export | Kind | Notes |
| --- | --- | --- |
| `createBrowserOAuthLauncher` | function | Browser launcher. |
| `createExtensionOAuthLauncher` | function | Extension launcher. |
| `createOAuthClient` | function | Lower-level oauth4webapi wrapper. |
| `createStorageAdapter` | function | `Storage -> OAuthTemporaryStorage`. |
| `OAuthClientError` | runtime factory + type | 7 variants. |
| `OAuthLauncher` | type | Local re-declaration of the launcher shape. |
| `OAuthClientConfig` | type | |
| `OAuthTemporaryStorage` | type | |

### apps/api/src/auth/ public surface (re-exported through file imports)

Only used inside `apps/api/`:

| Export | Source | Consumer |
| --- | --- | --- |
| `createAuth` | `create-auth.ts` | `app.ts`. |
| `BASE_AUTH_CONFIG`, `AUTH_BASE_PATH` | `base-config.ts` | `create-auth.ts`, `oauth-metadata.ts`. |
| `createCookieAdvancedConfig` | `cookie-config.ts` | `create-auth.ts`. |
| `deriveUserEncryptionKeys` | `encryption.ts` | `app.ts` for `/api/me`. |
| `singleCredential` | `single-credential.ts` | `app.ts` middleware. |
| `OAuthError`, `hasScope`, `WORKSPACES_OPEN_SCOPE` | `oauth-error.ts` | Resource-boundary callers. |
| `createOAuthIssuerURL`, `createOAuthJwksURL`, `OAUTH_*_PATH`, `OAUTH_METADATA_CACHE_CONTROL` | `oauth-metadata.ts` | `app.ts`. |
| `createOAuthUnauthorizedResourceResponse` | `oauth-resource.ts` | `app.ts`, `api-me.test.ts`, `health.test.ts`. |
| `parseBearer`, `resolveBearerUser`, `resolveBearerIdentity`, `resolveRequestOAuthUser`, `resolveRequestWorkspaceIdentity` | `resource-boundary.ts` | `app.ts`, `single-credential.ts`, tests. |
| `WorkspaceIdentity` | `resource-boundary.ts` | `app.ts` `Env.Variables.user` type. |
| `WORKSPACES_OPEN_SCOPE` | re-exported from resource-boundary too. | |
| `ensureTrustedOAuthClients`, `projectTrustedOAuthClientToRow`, `trustedOAuthClientIds` | `trusted-oauth-clients.ts` | `app.ts`, `create-auth.ts`, tests. |

### apps/api/src/auth-pages/ public surface

| Export | Notes |
| --- | --- |
| `renderSignInPage`, `renderConsentPage`, `renderSignedInPage`, `renderCliCallbackPage` | The four server-rendered Hono JSX entry points. All used by `app.ts`. |
| `AUTH_STYLES` | Inline CSS. Used by `layout.tsx`. |

### Routes touched by this audit (in `app.ts`)

- `GET /` (unauth): health
- `GET /sign-in`, `GET /consent`: Better Auth UI
- `GET /auth/cli-callback`: OOB code paste page
- `GET /api/me`: single identity surface
- `GET /.well-known/openid-configuration`, `/.well-known/oauth-authorization-server[/auth]`, `/.well-known/oauth-protected-resource`: discovery
- `app.on(['GET','POST'], '/auth/*', ...)`: Better Auth handler
- `GET /api/health`: claimed bearer-liveness probe

## Candidate table

| # | Target | Current shape | Proposed collapse | Evidence | Disposition |
| --- | --- | --- | --- | --- | --- |
| C1 | `GET /api/health` + `requireOAuthUser` mount + `health.test.ts` | Authenticated 200/ok route guarded by `workspaces:open`; docstring claims CLI pings it "after a local id_token decode." | Delete the route, the middleware mount on `/api/health`, and the whole `health.test.ts`. CLI's `status` already pings `/api/me` (`packages/auth/src/node/machine-auth.ts:203`). | `apps/api/src/app.ts:356,363-370`; `apps/api/src/health.test.ts` (only caller in repo). | **Collapse landed in-place.** |
| C2 | `@epicenter/auth/node/machine-auth` export subpath | `packages/auth/package.json` exposes both `./node` (full barrel) and `./node/machine-auth` (one module). Single caller. | Drop the subpath; rewrite the caller to `@epicenter/auth/node`. | `packages/auth/package.json:exports`; `packages/cli/src/commands/auth.ts:14`. | **Collapse landed in-place.** |
| C3 | Duplicate `OAuthSignInLauncher` declaration | `packages/auth/src/node/oob-launcher.ts:56-58` redeclares the same type as `create-oauth-app-auth.ts:30-32` "so this module is independently usable." | Import the type from `../create-oauth-app-auth.js` and delete the local copy. Same package. | grep above. | **Collapse landed in-place.** |
| C4 | `WorkspaceIdentity` declared in two places | `apps/api/src/auth/resource-boundary.ts:15-18` (server response) and `packages/auth/src/node/machine-auth.ts:60-63` (CLI return). Shapes identical: `{ user: { id, email }, encryptionKeys }`. | Either inline the shape at the CLI boundary (one caller in `commands/auth.ts`) or have the CLI consume the server's exported type via a shared package. | grep above. | **Keep (defer).** See keep paragraph. |
| C5 | `OAuthLauncher` (third launcher type) in `oauth-launchers/index.ts:78-80` | A third locally-declared launcher type; same shape as `OAuthSignInLauncher`. Internal to `oauth-launchers/`. | Import `OAuthSignInLauncher` from `../create-oauth-app-auth.js`. | grep above. | **Keep (defer).** See keep paragraph. |
| C6 | `MachineAuthRequestError` with a single `RequestFailed` variant | `defineErrors({ RequestFailed: ... })`. Lots of factories with one variant tend to be ceremony tails. | Replace with a plain `Error` subclass or fold into `OobLauncherError`. | `packages/auth/src/node/machine-auth.ts:44-52`. | **Keep.** See keep paragraph. |
| C7 | `LoginWithOobResult.identity.user.email` returned as `''` on `unverified` status | Empty string is a null sentinel; CLI uses `email || 'Account'`. | Make the field optional (`email?: string`) or strip it from the unverified branch and surface it only when verified. | `packages/auth/src/node/machine-auth.ts:240-246`; `packages/cli/src/commands/auth.ts:84-85`. | **Keep.** See keep paragraph. |
| C8 | Stale "after a local id_token decode" docstrings | `apps/api/src/app.ts:362-370` and `apps/api/src/health.test.ts:6` reference an id_token decode path that the profile-as-application-data spec retracted. | Delete the docstrings (and the route in C1). | grep above. | **Subsumed by C1.** |

## Asymmetric-wins pass

Per `cohesive-clean-breaks`, run a 10-20%-refusal-buys-80-90%-collapse check on every candidate.

| Candidate | Refuse what | Collapse what | Score |
| --- | --- | --- | --- |
| C1 | One redundant authenticated liveness endpoint. | Removes a route, a middleware mount, three tests, two stale docstrings, and one mental model of "two ways to check if the bearer still works." `/api/me` already returns 200 on a live bearer. | **High.** Refuses ~5 lines of route, gets back ~150 lines of test + docstrings + a removed duplicate verb. |
| C2 | One redundant subpath export. | Drops a `package.json` line + a node.ts entrypoint duplication. One caller updated. | **Medium.** Small refuse, small collapse, but the principle (one entrypoint per surface) is worth applying. |
| C3 | A local type duplication. | A 3-line comment + 3-line type body removed; downstream the type is the *same* identity. | **Medium-high.** Free win. |
| C4 | A duplicate `WorkspaceIdentity` declaration. | Would collapse two definitions to one but the cohesive cost is moving a server type into a shared package, which entangles `apps/api` and `packages/auth` more than they currently are. The two `WorkspaceIdentity`s have different homes for a reason: the server's is the *truth shape* of `/api/me`, the CLI's is a *display payload*. | **Low; keep separate.** |
| C5 | A second redundant launcher type. | Would collapse a 3-line type. But `oauth-launchers/` is the browser/extension lane; conceptually it's a sibling, and forcing it to import from a Node-also-used module entangles browser builds. | **Low; keep.** Defer with a one-paragraph note. |
| C6 | A typed `RequestFailed` wrapper. | Would lose a wellcrafted error name at the boundary. The single-variant smell exists, but the wrapper carries the discriminator that distinguishes "I tried to call /api/me and it bailed" from raw fetch errors. | **Low; keep.** |
| C7 | A `''` sentinel field. | Would tighten the type but force a CLI branch (`if (identity.user.email != null) ... else ...`) where today `email || 'Account'` works in one line. | **Low; keep.** |
| C8 | Stale docstrings without removing the route. | Trivial; consumed by C1 anyway. | n/a. |

The 10-20%-refusal that buys 80-90%-collapse is **C1**. C2 and C3 are housekeeping wins that come along for free in the same audit.

## Dispositions

### C1: collapse landed

The `/api/health` route was added before the api-me waves landed under the assumption that the CLI would call a no-body liveness probe after locally decoding `id_token` claims (the retracted `id-token-bearing-encryption-keys` design). After that design was withdrawn, the CLI's `status` was rewritten to ping `/api/me` directly (`packages/auth/src/node/machine-auth.ts:203 client.fetch('/api/me')`). The route is now dead in two senses: no in-repo caller actually hits it, and its raison d'être (id_token decode) no longer exists. Removing it deletes:

- the `app.use('/api/health', requireOAuthUser)` mount (`apps/api/src/app.ts:356`)
- the `app.get('/api/health', ...)` handler with the misleading docstring (`apps/api/src/app.ts:363-370`)
- `apps/api/src/health.test.ts` (3 tests, ~160 lines)
- the misleading docstring on `health.test.ts:1-12`

The CLI's status command continues to verify the bearer by calling `/api/me`, which already returns 200 on a valid scoped bearer and 401/403 otherwise. The "single identity surface" principle from the api-me spec is reinforced: one endpoint, one purpose.

### C2: collapse landed

`packages/auth/package.json` exposes `./node` *and* `./node/machine-auth`. The latter is a one-module subpath that is fully covered by the former (`node.ts` re-exports `./node/machine-auth.js` in full). The single caller (`packages/cli/src/commands/auth.ts:14`) imports `* as machineAuth` either way; switching to `@epicenter/auth/node` flattens the surface to one entry point. This matches the "one obvious place" principle of `cohesive-clean-breaks`.

### C3: collapse landed

`packages/auth/src/node/oob-launcher.ts:53-58` redeclares `OAuthSignInLauncher` with a comment "Declared here as well so this module is independently usable." But the module is in the same package as `create-oauth-app-auth.ts`, where the type already lives, and the relative-import path (`../create-oauth-app-auth.js`) is the cheapest possible reference. The redeclaration buys nothing and forces the two declarations to drift if the contract ever changes. Importing the type fixes that.

### C4: keep / defer

The two `WorkspaceIdentity` types are structurally identical but live in different conceptual planes. The server's `resource-boundary.WorkspaceIdentity` is the *response shape* of `/api/me`, validated against the `AuthUser` arktype at the resource boundary. The CLI's `machine-auth.WorkspaceIdentity` is a *display payload* the CLI receives back from `loginWithOob` and `status` for the "Signed in as alice@..." line. Per `profile-as-application-data`, email-as-display is *application data*, not identity data; collapsing the two types would force the CLI to either depend on an `apps/api` export (entangling deployable apps with library packages) or move both definitions to a shared package, which would put a `/api/me` server response type into a published library where it would imply a contract that has nothing to do with what the library exposes. The duplication is the cost of keeping the server's wire shape and the CLI's display shape conceptually distinct. **Why:** profile-as-application-data spec made identity-vs-display a deliberate split. **How to apply:** revisit only if a third caller appears that needs the same shape.

### C5: keep / defer

`oauth-launchers/index.ts` declares a third launcher type (`OAuthLauncher`) for the browser/extension flow. The duplication is the same shape but the file is in the browser/extension lane, not the Node lane. Importing `OAuthSignInLauncher` from `create-oauth-app-auth.ts` would work today, but the modules deliberately sit in separate dirs to keep the browser tree-shake clean of Node-side imports. The type is one of the cheapest things in the file. **Why:** browser/extension build cleanliness; entanglement risk. **How to apply:** collapse when a single launcher type is needed at a third site, or when the tree-shake invariant is enforced by a lint rule.

### C6: keep

`MachineAuthRequestError` carries one variant (`RequestFailed`). The single-variant `defineErrors` is a mild smell, but the wrapper exists to give callers a name to discriminate on at the CLI boundary ("the network call to /api/me failed" vs "the OOB token exchange failed"). Replacing it with a plain `Error` subclass would lose the wellcrafted Result discriminator at zero gain. **Why:** the discriminator earns its keep at the CLI's two callers (`loginWithOob` and `status`). **How to apply:** if a second variant is ever added (e.g., `RequestRejected` for a 4xx), the value of the factory becomes obvious; until then, it's a one-line cost paying for a typed boundary.

### C7: keep

`status`'s `unverified` branch returns `identity.user.email = ''`. The CLI consumes it with `identity.user.email || 'Account'`. The alternative (an `email?: string` field or a discriminated union with two identity shapes) would push branching into the CLI. The empty-string sentinel is conventionally a null-equivalent for a non-nullable string field that the caller already knows how to ignore. **Why:** the CLI consumes the field with `||`, which already handles both "no /api/me" and "empty email." **How to apply:** revisit only if a non-falsy-but-missing email is ever a real shape.

### C8: subsumed by C1

Stale docstrings on `app.ts:362-370` and `health.test.ts:1-12` reference id_token decoding that was retracted. Removing the route removes both docstrings.

## Validation transcript

Run after C1+C2+C3 landed in-place on the current branch.

```
$ bun --cwd packages/auth typecheck
$ tsc --noEmit
(exit 0; no diagnostics)

$ bun --cwd packages/auth test
$ bun test
bun test v1.3.3 (274e01c7)
... 50 pass, 0 fail, 159 expect() calls across 5 files (399 ms)
(exit 0)

$ cd packages/cli && bunx tsc --noEmit
src/commands/run-peer-errors.test.ts(56,35): error TS2353: ...
src/commands/run.ts(184,48): error TS2339: ...
../workspace/src/document/rpc.ts(86,2): error TS2322: ...

  Diagnostics live in packages/workspace/src/document/rpc.ts (the user's
  in-flight markdown/rpc refactor on this branch, visible in `git status`
  as modified `materializer/*` files and a new `packages/workspace/src/
  markdown/` dir) and the two CLI files that depend on its types. None of
  the failing files import from any of the auth surfaces touched by this
  audit. Re-running the same command against `main` (or stashing the WIP)
  reproduces the same diagnostics. Pre-existing; not caused by this audit.

$ cd apps/api && bunx tsc --noEmit
../../packages/workspace/src/document/rpc.ts(86,2): error TS2322: ...
  Same pre-existing rpc.ts diagnostic. apps/api has no native build step
  (Cloudflare Workers builds at deploy time via wrangler); `tsc --noEmit`
  on its tsconfig is the closest equivalent. No auth-related errors.

  Auth-only proof: the api file edited in C1 (apps/api/src/app.ts) still
  parses cleanly under hono/jsx + bun types; the only edits removed a
  middleware line and a route handler whose imports (requireOAuthUser was
  not removed because it's still used by /ai, /rooms, /api/billing,
  /api/assets) all remain valid.
```

The auth package is green. The CLI and api `tsc --noEmit` failures are isolated to workspace/rpc files that are part of an unrelated WIP refactor visible in this branch's working tree (`git status` shows the materializer/markdown moves and new files). The auth changes themselves typecheck on the auth package and don't introduce new diagnostics anywhere downstream.

## Net surface change

```
Public-symbol delta (named exports from @epicenter/auth*, public HTTP routes,
package.json export subpaths, source-level type declarations):

3 removed / 0 added

  -1 GET /api/health                                  (route)
  -1 "./node/machine-auth"                            (package.json export subpath)
  -1 OAuthSignInLauncher                              (duplicate type in oob-launcher.ts)

  Symbol-level: the loginWithOob / status / logout / createMachineAuthClient
  surface remains reachable via @epicenter/auth/node; only the duplicate
  entry point was retired. No top-level exports of @epicenter/auth or
  @epicenter/auth/node were added or removed.

Source files deleted: 1
  - apps/api/src/health.test.ts (3 tests, ~160 lines)

Source files touched: 4
  - apps/api/src/app.ts                       (-15 lines: route + middleware)
  - packages/auth/package.json                (-1 export subpath)
  - packages/cli/src/commands/auth.ts         (1 import path rewrite)
  - packages/auth/src/node/oob-launcher.ts    (-6 lines: dup type)

Kept for cohesion (see disposition paragraphs):
  - WorkspaceIdentity in two places (server response vs CLI display payload)
  - OAuthLauncher in oauth-launchers/ (browser/extension lane separation)
  - MachineAuthRequestError single-variant factory
  - LoginWithOobResult.identity.user.email empty-string sentinel on `unverified`
```

## Stop condition

Every row in the candidate table has a disposition (3 collapses landed, 4
keeps with one-paragraph justifications, 1 subsumed). Targeted `packages/auth`
validation exits 0; downstream typecheck failures isolated to the user's WIP
in `packages/workspace`. Audit ends with the net-surface line above.
