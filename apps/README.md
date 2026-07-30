# Apps

Each app under `apps/` owns its hosted UI plus, when it is a library for other
surfaces, one inert data contract it exports from its package root.

Apps currently use one of two lanes. New work starts from a Lens.

## The canonical Lens lane

An app declares one namespace it interprets, and a runtime binds it:

```txt
defineLens({ namespace, tables, values })
  the inert contract: no storage, no network, no framework

epicenter.bind(lens)
  a bound handle: { tables, values }, each reporting when its data may be stale
```

The Lens is a partial interpretation of one durable namespace (ADR-0160). It
creates no lifecycle scope, so binding it is the runtime's job, not its own.
Fields validate present values and the table lens owns presence
(`defineTable({ fields })` plus `optional(...)`, `defineValue`).

Every ordinary row has at most one latent document, opened through
`table.openDocument(rowId)`. Applications own the roots inside it.

A bound handle reports staleness rather than pushing values: a table
invalidation can sometimes name the changed row ids, a value invalidation
cannot, because a value has no smaller identity to name (ADR-0187).

A Lens has no document declarations, room catalog, user-data migration API,
schema hash, or successor database. Applications receive no SQL; relational
inspection belongs to Epicenter Home (ADR-0162).

In this lane today: `tab-manager`, `honeycrisp`, `whispering`, `vocab`,
`skills` (its Lens lives in `packages/skills/src/workspace.ts`), and the
`epicenter` host (`apps/epicenter/src/workspace.ts`).

## The transitional root-Yjs lane

`apps/wiki` is the last app on the root-Yjs record path
(`apps/wiki/src/lib/workspace/index.ts`):

```txt
defineWorkspace()
  the app's shared isomorphic definition

createWorkspace()
satisfiesWorkspace()
  lower-level primitives for internals, tests, and older ports
```

Its definition-owned `create`/`connect`, `defineKv`, `.docs`, and `_v` APIs
remain compatibility surfaces in `@epicenter/workspace` until it migrates. Do
not copy them into a Lens app, and do not mix the two record authorities inside
one app.

## Layout

The inert contract is the package root export, and runtime composition sits
beside it:

```txt
apps/<app>/
├── src/lib/workspace/
│   ├── index.ts      the Lens and its row types
│   └── browser.ts    opens the replica, attaches sync
├── src/              SvelteKit app or WXT entrypoints
└── package.json      "exports": { ".": "./src/lib/workspace/index.ts" }
```

`tab-manager`, `honeycrisp`, `whispering`, and `wiki` use that nesting. `vocab`
keeps the same two files at the package root instead
(`apps/vocab/vocab.ts`, `apps/vocab/vocab.browser.ts`). Follow the existing
package shape; the boundary is the same either way, and forking the contract
file forks sync compatibility with peers running the canonical Lens.

Multi-platform apps put runtime-specific implementations behind `#platform/*`
build-time subpath imports (see `honeycrisp`'s `#platform/auth`, resolved to
`apps/honeycrisp/src/lib/platform/auth.tauri.ts` or `auth.browser.ts`).

No app exports a `./mount` or ships a `mount.ts`. Daemon mounts are declared in
an `epicenter.config.ts` with `defineMount` from `@epicenter/workspace/daemon`
and run by the CLI watcher; see `packages/cli/README.md`.

## Browser replicas

`openBrowserEpicenter` constructs a DedicatedWorker that claims one exclusive
Web Lock over one OPFS SQLite file. That replica is owned by the pair of the
storage partition the user agent resolves for the document and that document's
origin (ADR-0165, amended by ADR-0177). A second same-partition document is
refused immediately rather than queued: there is no election, broker, or
handoff protocol.

Sign-in is an enhancement, never a door (ADR-0088). The replica is the same one
either way; signing in attaches a sync session to the replica already open, and
signing out detaches. Nothing downstream branches on auth, and no identity
change swaps the underlying storage.

## Adding an app

1. Add the inert contract: `apps/<app>/src/lib/workspace/index.ts` (or
   `apps/<app>/<app>.ts`), exporting one `defineLens({ namespace, tables,
   values })` value plus its row types.
2. Point `package.json` `exports["."]` at that file, if other surfaces import
   it.
3. Add the runtime composition beside it (`browser.ts`), opening the replica and
   attaching sync for signed-in auth.
4. Bind the Lens once where the app is acquired, and pass the resulting handle
   to ordinary application services. Do not spread the handle through the UI.
5. Add the app to `docs/licensing/licensing-strategy.md` and, if it needs the
   hosted API in development, a `dev:<app>` script at the repo root.
