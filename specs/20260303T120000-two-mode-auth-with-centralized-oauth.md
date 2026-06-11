# Two-Mode Auth with Centralized OAuth

**Status**: Implemented
**Branch**: braden-w/rm-token-auth

## Summary

Remove the token auth mode from sync auth, simplifying from three modes (open/token/verify) to two modes (open/verify). The `{ token: string }` variant was a shared-secret approach being replaced by Better Auth's session-based verify mode.

## Implementation Plan

### Wave 1: Server-side auth (packages/server/)

- [x] **1.1** `packages/server/src/sync/auth.ts`: Removed `{ token: string }` from `AuthConfig` union. Removed `'token' in config` branch. AuthConfig is now `{ verify: fn }`.
- [x] **1.2** `packages/server/src/sync/auth.test.ts`: Removed `describe('token mode', ...)` suite. Updated edge cases to use `{ verify: ... }`.
- [x] **1.3** `packages/server/src/sync/plugin.test.ts`: Replaced all `{ token: 'secret' }` with `{ verify: (t) => t === 'secret' }`.
- [x] **1.4** `packages/server/src/index.ts`: No change needed (no `tokenAuth` export exists).
- [x] **1.5** `packages/server/src/sync/index.ts`: No change needed (no `tokenAuth` export exists).

### Wave 2: Server-remote auth enhancements

- [x] **2.1** `packages/server-remote/src/auth/plugin.ts`: Extended `AuthPluginConfig` with `emailAndPassword` and `socialProviders`. Added `seedAdminIfNeeded()`. Made `createAuthPlugin` accept a pre-created auth instance to enable sharing.
- [x] **2.2** `packages/server-remote/src/remote.ts`: Auto-wires `{ verify }` from Better Auth session when `config.auth` is set but `sync.auth` is not. Shares a single auth instance between the auth plugin and sync verify.

### Wave 3: Client-side sync simplification

- [x] **3.1** `packages/sync/src/types.ts`: Removed `token?: string` from `SyncProviderConfig`. Updated JSDoc to two-mode auth.
- [x] **3.2** `packages/sync/src/provider.ts`: Removed `staticToken` destructuring and code path. Also updated `provider.test.ts` and `plugin.test.ts` to use `getToken` instead of `token`.

## Review

**Completed**: 2026-03-03
**Branch**: braden-w/rm-token-auth

### Summary

Simplified sync auth from three modes (open/token/verify) to two (open/verify) across server, server-remote, and sync packages. The server-remote package now auto-wires sync auth from Better Auth sessions, so `createRemoteServer({ auth: {...} })` just works without explicit sync auth config.

### Deviations from Spec

- The original task mentioned removing `tokenAuth()` factory functions and exports: these didn't exist in the codebase. The actual code used inline `{ token: string }` object literals, which were removed.
- `createAuthPlugin` was extended to accept a pre-created Better Auth instance (not in the original spec) to avoid creating duplicate auth instances in `createRemoteServer`.
- Client-side `token` field removal cascaded to `provider.test.ts` (not listed in the original spec).

### Follow-up Work

- Token broker endpoint (GET `/auth/connections/:provider` on server-remote): separate PR as noted in spec Wave 4.
