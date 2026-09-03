# @epicenter/app

The handle an application reaches its capabilities through: its Epicenter Data,
its own SQLite files, and its secrets. AGPL-3.0-or-later.

Every capability is scoped by the application's id, and the application states
that id once. A store's address carries the opening application (ADR-0324), and
the handle supplies it.

`apps/local-mail` is the app that uses this handle today, with no definition and
no account: its whole surface is `sqlite` and `secrets`.

The constructor is `createEpicenter`. It is not `createEpicenterClient`, which
is the HTTP client in `packages/client` and a different concern with a different
lifetime.

## The runtime is the import path

```ts
import { createEpicenter } from '@epicenter/app/browser'; // or '@epicenter/app/desktop'
```

Both subpaths export `createEpicenter`, and the name never carries the runtime.
There is no runtime sniff here and there must not be one: the desktop build runs
in a WebView, so `typeof window` cannot tell it apart from a browser tab, and the
two differ in exactly the ways that matter, which are a keychain and a Bun-owned
file. An application selects its leaf through the `#platform/*` build condition
the repository already uses for the auth and instance seams; a build that forgot
to fails to resolve rather than quietly running the wrong owner.

| Import | What it gives you |
| --- | --- |
| `@epicenter/app/browser` | `createEpicenter`, over this origin's OPFS and tab memory |
| `@epicenter/app/desktop` | `createEpicenter`, over the trusted owner's files and the OS keychain |
| `@epicenter/app` | the types, `AppError`, `SecretError`, the two name mints and their guards, and the `(appId) => binding` form of `createEpicenter` the Bun host's leaf is built on |
| `@epicenter/app/protocol` | the request and response shapes both ends of the desktop seam read |

| Leaf | `sqlite` | `secrets` |
| --- | --- | --- |
| browser | SQLite WASM over this origin's OPFS | tab memory, forgotten on close |
| desktop | the trusted owner, over `/api/app-storage` | the OS keychain |

Neither leaf carries the store. It is client-owned in every runtime (ADR-0226,
ADR-0227), so `data` is composed above the seam rather than through it.

## The surface

```ts
const epicenter = createEpicenter({ definition, account });

epicenter.appId              // string, frozen
epicenter.sqlite.open(name)  // Promise<Result<AppSqliteDatabase, AppError>>
epicenter.sqlite.delete(name)// Promise<Result<void, AppError>>
epicenter.secrets            // SecretStore
epicenter.account            // the AuthClient the application passed in
epicenter.data               // Promise<Result<ReplicaData<TDefinition>, StoreError | DataDefinitionParseError>>
epicenter.eraseReplica()     // Promise<Result<void, StoreError>>
```

**`definition` and `account` arrive together or not at all.** An authority mints
every generation (ADR-0336), so there is no accountless store and no store
without sync. Pass neither and the handle has no `data` and no `account`, in the
type as well as at runtime; pass both and it has the superset.

**There is no `appId` to write.** It defaults to `definition.id`, and a data id
is always a legal application id. State it only when this application opens
another application's data, which nothing does; an application with no
definition states it because there is nothing to default from. An application
holds one store, and ADR-0339 says what changes on the day one holds two.

**`data` is a lazy getter that memoizes.** Reading it starts the open, so an
application that never reads it pays no Web Lock, no IndexedDB, and no round
trip, and reading it twice joins one open. Sync attaches inside. It resolves a
`Result`, and the error is the store's own rather than an `AppError` wrapping
it: a boot gate switches on the failure's `name` to choose between a retry and
an erase.

A failure is memoized with everything else, so the repair for a failed open is
a document reload rather than a second read of `data`. That is what a boot gate
already does: `AlreadyOpen` and `GenerationUnavailable` both repair by
reloading, and an erase leaves the page.

Every method answers a `Result`. Runtime differences are typed failures, never
branches: a browser build has no keychain, and the application handles that
because the type obliges it to.

What throws is what a build got wrong: `createEpicenter` on an application id
this platform cannot file, and the two name mints below. Everything that can
fail at runtime returns.

### The SQLite handle

```ts
const mail = await epicenter.sqlite.open(databaseName('mail'));

mail.run(sql, parameters?)     // Promise<Result<{ changes: number }, AppError>>
mail.all<TRow>(sql, params?)   // Promise<Result<TRow[], AppError>>
mail.batch(statements)         // Promise<Result<{ changes: number[] }, AppError>>
```

All, run, and batch. There is no `transaction`, so `batch` is how several
statements become one commit, and no `close`: `sqlite.delete(name)` is the only
thing that ends a handle. The handle takes no schema and runs no migration.

### Secrets

```ts
epicenter.secrets.put(label, value)  // Promise<Result<void, SecretError>>
epicenter.secrets.get(label)         // Promise<Result<string | null, SecretError>>
epicenter.secrets.delete(label)      // Promise<Result<void, SecretError>>
```

Three verbs and no enumeration, and no way to ask whether this runtime keeps a
secret across a session: a browser build answers `null` from `get` after a
reload, which is the same answer a new desktop device gives.

## Names are checked where they are minted

`DatabaseName` and `SecretLabel` are branded, so the check happens once at the
name rather than once per call:

```ts
const LOCAL = databaseName('local');            // throws: a constant in a build
const filed = isSecretLabel(sub) ? sub : null;  // narrows: a value that arrived
```

`databaseName` and `secretLabel` throw, because a name reaching them is a
constant and a wrong one is a bug. A name derived from something that arrived at
runtime is narrowed with `isDatabaseName` or `isSecretLabel` where it is born, so
the application can say what the person did rather than what the grammar is.

The desktop owner validates again on arrival: a brand is a compile-time fact, and
a request crossing the sidecar carries no types. The browser leaf has no second
line, because there is no owner on the other side of it; what a bad name reaches
there is OPFS, whose names are flat, so the blast radius of a JS caller casting
past the brand is one oddly named file in this origin.

`@epicenter/app/protocol` owns the grammar both ends read, plus
`APP_STORAGE_PATH` and the message types. The application id reuses `isAppId`
from `@epicenter/constants/app-id`.

## Why it is shaped this way

This README states the surface as it is today. The decisions behind it are
ADR-0339 (one epicenter, and an account is what adds a store), ADR-0316 (one
scoped handle), ADR-0312 (all, run, and batch), ADR-0310 (secrets as labels),
ADR-0321 (named files an application opens and deletes), and ADR-0181 (runtime
differences as typed failures). Read those for the reasoning, not for the
signatures.
