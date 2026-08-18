# Apps

There is one runtime: a desktop SPA in a WebView, served by a Bun host over a
store the client owns (ADR-0227). The host serves bundles and brokers
credentials; it owns no application data and constructs no database (ADR-0226).
Hosted web as a second runtime with a host-owned replica is refused, and so are
third-party installed apps, for now.

Not every folder here is that. `api` and `self-host` are server deployables,
`landing` is a public site, `local-books` and `local-mail` are headless mirrors
with their own CLIs, and `sync-lab` is a throwaway harness for watching a row
cross the wire. The rest of this page is about the surfaces that hold a person's
data.

## How a surface is put together

An application declares one inert workspace and opens its own store through it:

```txt
defineWorkspace({ id, title, kv, tables })
  pure JSON: no storage, no network, no framework

openDevice(workspace) / openAccount(workspace, { principalId })
  sqlite-wasm in the page, three durable relations in IndexedDB,
  one database per document (ADR-0233)

db.tables.notes.list()
  synchronous from here on
```

Opening the store is the only asynchronous thing the application does.
`db.notes.list()` returns rows, not a promise, and `db.notes.subscribe(...)`
reports which rows a commit touched, for a local write and for bytes from
another device alike (ADR-0221). Nothing polls, and there is no generation
counter to keep.

Every build opens its own store, with no seam deciding where data lives. Two
windows on one machine converge through the same authority every other device
uses, because a surface is a replica of one authority per signed-in account
(ADR-0225). Sign-in is never a door: the app works completely signed out, and
signing in attaches sync.

The full contract for the store is in
[`packages/data/README.md`](../packages/data/README.md).

## Layout

The inert workspace is the package root export, and runtime composition sits
beside it:

```txt
apps/<app>/
├── src/lib/workspace/index.ts   the workspace and its row types
├── src/lib/                     the store opener, sync, and app services
├── src/                         SvelteKit routes and components
└── package.json                 "exports": { ".": "./src/lib/workspace/index.ts" }
```

`honeycrisp` and `whispering` use that nesting; `vocab` keeps its workspace at
the package root instead (`apps/vocab/vocab.ts`) and composes in
`apps/vocab/src/lib/runtime.ts`. Follow the existing package shape. Forking the
workspace file forks sync compatibility with every peer running the canonical
one.

Where a build genuinely differs, put the difference behind a `#platform/*`
build-time subpath import rather than a runtime branch. Honeycrisp's
`#platform/auth` resolves to `auth.epicenter-host.ts`, `auth.tauri.ts`, or
`auth.browser.ts` under the `epicenter-host`, `tauri`, and default conditions.
Auth keeps a seam because the host really does broker a credential its windows
cannot obtain; storage does not, because it does not differ.

## Adding an app

1. Write the workspace at `apps/<app>/src/lib/workspace/index.ts`: one
   `defineWorkspace({ id, tables })` value plus its row types. Read the
   workspace rules first, especially that there are no optional fields and no
   array defaults.
2. Point `package.json` `exports["."]` at that file.
3. Add the store opener beside it, and a `dial` if the app syncs. The host
   supplies the socket; `@epicenter/data/sync` owns everything done with one
   (ADR-0222).
4. Open the workspace once where the app is acquired and pass the opened data
   handle to ordinary services. Do not spread it through the UI.
5. Add the app to `docs/licensing/licensing-strategy.md` and, if it needs the
   hosted API in development, a `dev:<app>` script at the repo root.

## Where each surface stands

`honeycrisp` is the surface built on the store, and its
[README](honeycrisp/README.md) is the worked example.

`whispering`, `vocab`, `skills`, and `epicenter` do not compile. The superseded
data stack was deleted before they were migrated, deliberately, because the
reverse order is impossible: there was nowhere for them to move until the
refusals landed (ADR-0227). Data those apps held on the old stack is accepted as
lost; there is no importer and there will not be one. What `vocab` and `skills`
should look like on the store is an open design question, not a deletion nobody
got to.
