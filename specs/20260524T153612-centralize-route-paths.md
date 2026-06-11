# Centralize URL Path Constants Under `@epicenter/constants`

**Date**: 2026-05-24
**Status**: Draft
**Author**: AI-assisted (claude@bradenwong.com)
**Branch**: braden-w/owner-collapse-and-cleanup

## Overview

Add `packages/constants/src/api-routes.ts` and `packages/constants/src/oauth-routes.ts` exporting path patterns + URL builders for every HTTP/WS endpoint Epicenter serves. Migrate every hardcoded path literal in the server, deployment, auth clients, workspace transport, and dashboard to import from there. Add a Biome GritQL guard mirroring `scripts/biome/c-json-errors.grit` that rejects new hardcoded `/api/...` literals outside the constants module.

URL **values** stay byte-identical to today's wire format. The refactor only moves declarations.

## Motivation

The wire-format error centralization (`specs/20260524T100110-centralize-c-json-error-responses.md`) collapsed five duplicated error definitions into four `defineErrors` files under `packages/constants/src/*-errors.ts` and added a GritQL guard rejecting ad-hoc `c.json({ name: '...' })` literals. The Decisions Log explicitly flagged URL paths as the next-most-obvious centralization candidate.

Same drift pattern: a single wire constant duplicated across server route declaration, deployment middleware pattern, client fetch URL, and tests. Same fix shape.

### Current State (drift surface)

**`/api/session`**: 6 hardcoded occurrences:
- `packages/server/src/routes/session.ts:27` (server route)
- `packages/auth/src/node/machine-auth.ts:355, 500`
- `packages/auth/src/node/oob-launcher.ts:10` (JSDoc)
- `packages/client/src/index.ts:98`
- `apps/api/src/index.ts:51` (deployment middleware)

**Asset URL pattern + `[a-z0-9]{21}` regex**: 11 occurrences across:
- `packages/server/src/routes/assets.ts:66-67` (`ASSET_ID_REGEX`, `ASSET_ROUTES_BASE_PATH`)
- `packages/client/src/index.ts` (6 hardcoded path constructions)
- `apps/api/src/index.ts:70, 77, 85` (3 deployment middleware patterns embedding the regex)

**Room URL pattern + `[a-z0-9]{15}` regex**: 3 occurrences:
- `packages/server/src/routes/rooms.ts:120` (`ROOM_PATTERN`)
- `packages/workspace/src/document/transport.ts:33` (`roomWsUrl`)
- `apps/api/src/index.ts:57` (deployment middleware)

**OAuth endpoint paths** (`/auth/oauth2/{token,authorize,revoke}`, `/auth/cli-callback`): 6 occurrences across `packages/auth/src/create-oauth-app-auth.ts`, `packages/auth/src/node/oob-launcher.ts`, `packages/server/src/routes/auth.ts`.

**AI chat endpoint** `/api/ai/chat` and `/api/ai/*`: 2 occurrences (server route + deployment middleware).

**Billing paths** `/api/billing/*`: dashboard client (`apps/dashboard/src/lib/api.ts:84-104`) + deployment mount.

### Desired State

```
packages/constants/src/
  api-routes.ts          # { session, room, assets.{list,usage,byId}, ai.chat, billing }
  oauth-routes.ts        # { cliCallback, token, authorize, revoke }
```

Each leaf exports `pattern` (Hono route string with `:param{regex}`), `prefixPattern` (where applicable for `.use('/.../*', ...)` middleware mounts), and `url(baseURL, ...args)` builder for client-side fetch. Regex constants (`ASSET_ID_REGEX`, `ROOM_ID_REGEX`) are exported separately for direct consumption by `nanoid` calls and explicit pattern composition.

Every server route handler, deployment middleware mount, client fetch call, and workspace transport builder imports its shape from there. No hardcoded `/api/...` literal survives outside `api-routes.ts`. CI rejects regressions via Biome GritQL.

## Migration Waves

### Wave A: create the constants module

Add `api-routes.ts` and `oauth-routes.ts` with the full surface. Wire `package.json` `exports` entries. No consumer changes. Typecheck `packages/constants`.

### Wave B: migrate server-side route declarations

`packages/server/src/routes/{session,rooms,assets,ai,auth}.ts` import patterns from the new module. Delete the local `ASSET_ID_REGEX`, `ASSET_ROUTES_BASE_PATH`, and `ROOM_PATTERN` constants. Typecheck + `bun test packages/server`.

### Wave C: migrate deployment middleware

`apps/api/src/index.ts` `.use(...)` and `.on(...)` patterns reference `API_ROUTES.*.pattern` and `.prefixPattern`. Typecheck.

### Wave D: migrate client URL builders

`packages/auth/src/{create-oauth-app-auth.ts,node/{machine-auth.ts,oob-launcher.ts}}`, `packages/client/src/index.ts`, `packages/workspace/src/document/transport.ts` (`roomWsUrl` body becomes a wrapper that calls `API_ROUTES.room.url` then rewrites `http(s)` → `ws(s)`; export stays). `apps/dashboard/src/lib/api.ts` migrates billing paths.

### Wave E: Biome GritQL guard

Add `scripts/biome/api-route-literals.grit` mirroring `scripts/biome/c-json-errors.grit`. Pattern rejects new template / string literals matching `/api/...` (excluding the constants module itself). Register in `biome.jsonc` plugins array.

## Decisions Log

**One file per route domain (api vs oauth).** Mirrors the error split (`asset-errors.ts`, `oauth-errors.ts`, `request-guard-errors.ts`, `ai-chat-errors.ts`). Two files isn't enough to warrant a directory.

**Object-literal `as const` shape, nested by resource.** Not a discriminated union, not a class. Mirrors the `API_ROUTES.assets.list` access pattern that reads top-to-bottom at every call site and lets autocomplete drive discovery.

**Both `pattern` (server) and `url(...)` (client) live on the same leaf.** A single source of truth means changing the asset URL renames one leaf in one file. Splitting server patterns from client builders into separate exports invites drift exactly where the current state has it.

**`roomWsUrl` export survives.** Workspace consumers depend on the WebSocket scheme rewrite (`http→ws`, `https→wss`). The body becomes a 3-line wrapper around `API_ROUTES.room.url(...)`. Inlining the wrapper at every call site duplicates the scheme rewrite.

**Better Auth internal routes not in scope.** `/auth/oauth2/{token,...}` are paths Epicenter CALLS as a Better Auth client. The constants module captures what Epicenter calls, not what Better Auth exposes. `.well-known/*` discovery paths stay in `packages/server/src/auth/oauth-metadata.ts` (computed from `AUTH_BASE_PATH`).

**No speculative routes.** Only constants that already exist in the codebase migrate. No `users.profile.url` for hypothetical future endpoints.

**`encodeURIComponent` on every URL param.** `roomWsUrl` already does this for `guid`; the centralized builders do it uniformly to prevent regressions when an owner id or asset id contains a reserved character.

## Verification

After Wave E:

1. `git grep -nE "'/api/(session|owners|ai|billing)" packages/ apps/` matches ONLY in `packages/constants/src/api-routes.ts`.
2. `git grep -nE "/auth/(oauth2|cli-callback)" packages/auth packages/server apps/api` matches ONLY in `packages/constants/src/oauth-routes.ts` (plus this spec).
3. Smoke-test the GritQL guard: temporarily add `await fetch('/api/test')` in a consumer file, confirm Biome flags it. Revert.

## Reference

- `specs/20260524T100110-centralize-c-json-error-responses.md`: the error spec being mirrored.
- `2b5d7585f refactor(api): align route mounts and error envelopes`: the error envelope landing commit.
- `523ba0c0d refactor(server,constants): centralize OAuthError and route asset 404 through AssetError`: the analogous "pick up the deferred straggler" pass.
- `fbbf8f42d chore(lint): swap c.json error grep guard for Biome GritQL plugin`: the GritQL plugin shape Wave E mirrors.
