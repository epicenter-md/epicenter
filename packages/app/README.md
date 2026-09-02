# @epicenter/app

The handle an application reaches its capabilities through: its Epicenter Data,
its own SQLite files, and its secrets. AGPL-3.0-or-later.

Every capability is scoped by the application's id, including `openData`: a
store's address carries the opening application (ADR-0324), and the handle
supplies it so an application never writes its own id twice.

`apps/local-mail` is the app that uses this handle today. `apps/honeycrisp` calls
`openDatabase` from `@epicenter/data/browser` directly and does not import this
package.

The constructor is `createEpicenter`. It is not `createEpicenterClient`, which
is the HTTP client in `packages/client` and a different concern with a different
lifetime.

The package has one application entrypoint and three wiring entrypoints:

| Import | What it gives you |
| --- | --- |
| `@epicenter/app` | `createEpicenter`, the handle types, `AppError` and `SecretError` |
| `@epicenter/app/browser` | `createBrowserBinding({ appId, sqlite? })`, the standalone web runtime |
| `@epicenter/app/desktop` | `createDesktopBinding({ appId, baseURL?, fetch? })`, the Epicenter WebView runtime |
| `@epicenter/app/protocol` | the request and response shapes both ends of the desktop seam read |

`@epicenter/app/client-owned-data` exports `openClientOwnedData`, which both
bindings use for `openData`. An application does not import it.

## The surface

```ts
import { createEpicenter } from '@epicenter/app';
import { createBrowserBinding } from '@epicenter/app/browser';

const epicenter = createEpicenter({
	appId: 'so.epicenter.local-mail',
	binding: createBrowserBinding({ appId: 'so.epicenter.local-mail' }),
});

epicenter.appId                          // string, frozen
epicenter.openData(definition, account)  // Promise<Result<ReplicaData<TDefinition>, AppError>>
epicenter.openSqlite(name)               // Promise<Result<AppSqliteDatabase, AppError>>
epicenter.deleteSqlite(name)             // Promise<Result<void, AppError>>
epicenter.secrets                        // SecretStore
```

Every method answers a `Result`. Runtime differences are typed failures, never
branches: a browser build has no keychain, and the application handles that
because the type obliges it to.

`createEpicenter` throws on an invalid `appId`, because that is a build mistake
rather than a runtime condition. Everything else that can fail returns.

### The SQLite handle

```ts
const mail = await epicenter.openSqlite('mail');

mail.run(sql, parameters?)     // Promise<Result<{ changes: number }, AppError>>
mail.all<TRow>(sql, params?)   // Promise<Result<TRow[], AppError>>
mail.batch(statements)         // Promise<Result<{ changes: number[] }, AppError>>
```

All, run, and batch. There is no `transaction`, so `batch` is how several
statements become one commit, and no `close`: `deleteSqlite(name)` is the only
thing that ends a handle. The handle takes no schema and runs no migration.

### Secrets

```ts
epicenter.secrets.put(accountId, value)  // Promise<Result<void, SecretError>>
epicenter.secrets.get(accountId)         // Promise<Result<string | null, SecretError>>
epicenter.secrets.delete(accountId)      // Promise<Result<void, SecretError>>
```

Three verbs and no enumeration, and no way to ask whether this runtime keeps a
secret across a session: a browser build answers `null` from `get` after a
reload, which is the same answer a new desktop device gives.

## The binding is chosen at build time

`createEpicenter` requires a `binding`. There is no runtime sniff here and there
must not be one: the desktop build runs in a WebView, so `typeof window` cannot
tell it apart from a browser tab, and the two differ in exactly the ways that
matter, which are a keychain and a Bun-owned file.

An application selects its leaf through the `#platform/*` build condition the
repository already uses for the auth and instance seams. A build that forgot to
fails to resolve rather than quietly running the wrong owner.

| Binding | `openSqlite` | `secrets` |
| --- | --- | --- |
| browser | SQLite WASM over this origin's OPFS | tab memory, forgotten on close |
| desktop | the trusted owner, over `/api/app-storage` | the OS keychain |

Both bindings share `openData`: the store is client-owned in every runtime, so
there is no admission round trip in either.

## Names both ends validate

`@epicenter/app/protocol` owns the grammar both ends read: `isProtocolAppId`,
`isDatabaseName`, and `isSecretLabel`, plus `APP_STORAGE_PATH` and the request
and response types. The application id reuses `isAppId` from
`@epicenter/constants/app-id`.

## Why it is shaped this way

This README states the surface as it is today. The decisions behind it are
ADR-0316 (one scoped handle), ADR-0312 (all, run, and batch), ADR-0310 (secrets
as labels), ADR-0321 (named files an application opens and deletes), and
ADR-0181 (runtime differences as typed failures). Read those for the reasoning,
not for the signatures.
