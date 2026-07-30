# Never-Touch and Pause List

Codebase-specific facts that the collapse pass must respect. These strings, shapes, and packages outlive any individual session; changing them silently breaks on-disk data, sync, or downstream consumers.

## Durable strings: never change without explicit product decision

These appear in on-disk paths, sync wire format, or schemas other apps validate against. They are part of the durable vocabulary of Epicenter.

### IndexedDB and BroadcastChannel key

```
"epicenter/{server}/principals/{principalId}/{ydocGuid}"
```

Used by the browser-side workspace runtime (`packages/workspace/src/document/local-yjs-key.ts`). Forward slashes, includes the API origin host as `{server}` so two deployments on the same browser profile don't collide, and partition segment is `principals/{principalId}/` to match the server's URL and R2 shape. Changing the format detaches every existing IndexedDB store from its consumer.

### Durable Object name format and URL shape

```
"principals/{principalId}/rooms/{roomId}"
```

Used by the sync hub to address rooms (`packages/server/src/principal.ts`, `doName()`). Same shape on the wire: `/api/principals/:principalId/rooms/:roomId`. Changing the format breaks the routing contract between client and hub.

In the per-user topology `principalId` is the signed-in user's id; in the instance topology it is the literal `INSTANCE_PRINCIPAL_ID` (`'instance'`). The path is uniform across topologies.

### Public arktype schemas

Other apps validate inputs against these by name and shape. Renaming a field or changing a brand silently invalidates their parsers.

- `PersistedAuth` (`packages/auth/src/auth-types.ts`)
- `ApiSessionResponse` (`packages/auth/src/auth-types.ts`)
- `PrincipalId`, `INSTANCE_PRINCIPAL_ID` (`packages/identity/src/identity.ts`)

Per-user vs instance partitioning is intentionally NOT in this list: there is no
`OwnershipRule` engine or discriminated union (the old `perUser` / `instance`
constants and `packages/server/src/ownership.ts` are gone). The partition path
is one unconditional `principals/<principalId>/` shape in
`packages/server/src/principal.ts`; which principal a request resolves to is
decided at the bearer resolver, carries no arktype validator, and never crosses
the wire as config.

### Identity strings inside documents

- Y.Doc guid values (workspace identity for sync and persistence)
- Sync room names
- Child document GUIDs (deterministic per row, used by materializers and editors)

## Pause and ask before

The collapse pass should stop and surface to the user (not silently proceed) when about to:

- Change any string from the list above
- Delete a public exported name that has zero in-repo callers but plausible external CLI or SDK consumers (the `@epicenter/cli` binary and the `@epicenter/workspace` published API are the load-bearing examples)
- Collapse two files where one's JSDoc documents a non-obvious invariant (the JSDoc is the documentation of a contract; losing it loses the contract)
- Merge packages or move exports across package boundaries
- Change a function signature that crosses a published package boundary
- Collapse a `defineErrors` factory call to an inline `{ name, message, ...fields }` object, even for a single-variant log-only error. The factory call is the idiomatic shape; see `define-errors`, `error-handling`, and `logging` skills. Single-variant `defineErrors` is fine: the variant tag carries idiom consistency, forward-compat, self-documenting call sites, and a centralized message template that prevents drift across multiple log sites.

## Scope tiers

Default collapse-pass targets, narrowest to widest:

1. `packages/auth`
2. `packages/workspace`
3. `packages/svelte-utils`
4. `packages/cli`
5. `apps/api`

Out of scope without an explicit pass declaration:

- First-party apps: `apps/whispering`, `apps/tab-manager`, `apps/honeycrisp`, `apps/vocab`. These are owned by separate waves and have their own architecture tests.
- `specs/`, `docs/articles/`, migration history (`*-legacy-*.md`, archived decision docs)
