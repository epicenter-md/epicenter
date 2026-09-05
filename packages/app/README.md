# @epicenter/app

The handle an application reaches its capabilities through: its Epicenter Data,
its own SQLite files, and its secrets. AGPL-3.0-or-later.

Every capability is scoped by the application's id, and the application states
that id once. A store's address carries the opening application (ADR-0324), and
the handle supplies it.

`apps/local-mail` is the app that uses this handle today, with no definition and
no account: its whole surface is `sqlite` and `secrets`.

The constructor is `createEpicenter`, one of it, at the root. It is not
`createEpicenterClient`, which is the HTTP client in `packages/client` and a
different concern with a different lifetime.

## The runtime is the binding's import path

There is one `createEpicenter` and it serves every build. What varies by runtime
is a Bun-owned file and a keychain, so that is what the runtime subpaths export:
a binding, which an application selects through its own `#platform/binding` seam
and composes in one file.

```ts
// src/lib/platform/binding.browser.ts
import type { EpicenterBindingFactory } from '@epicenter/app';
import { createBrowserBinding } from '@epicenter/app/browser';

export const binding: EpicenterBindingFactory = createBrowserBinding();
```

```ts
// src/lib/epicenter.ts, one file for every build
import { createEpicenter } from '@epicenter/app';
import { binding } from '#platform/binding';

export const epicenter = createEpicenter({ appId, definition, account, binding });
```

There is no runtime sniff here and there must not be one: the desktop build runs
in a WebView, so `typeof window` cannot tell it apart from a browser tab. An
application selects its leaf through the `#platform/*` build condition the
repository already uses for the auth seam; a build that forgot to fails to
resolve rather than quietly running the wrong owner.

| Import | What it gives you |
| --- | --- |
| `@epicenter/app` | `createEpicenter`, the types, the errors, and the name mints |
| `@epicenter/app/browser` | `createBrowserBinding`, over this origin's OPFS and tab memory |
| `@epicenter/app/desktop` | `createDesktopBinding`, over the trusted owner's files and the OS keychain |
| `@epicenter/app/protocol` | the request and response shapes both ends of the desktop seam read |

| Binding | `sqlite` | `secrets` |
| --- | --- | --- |
| browser | SQLite WASM over this origin's OPFS | tab memory, forgotten on close |
| desktop | the trusted owner, over `/api/app-storage` | the OS keychain |
| host | the Bun process's own connection | the OS keychain, directly |

No binding carries the store. It is client-owned in every runtime (ADR-0226,
ADR-0227), so `data` is composed above the seam rather than through it.

**A binding is a function of `appId`, not a value beside one.** The handle
resolves the id and hands it over, so the files and the keychain cannot be
scoped to a different application than the store. That mismatch is the pair
ADR-0339 is named for, and this is what makes it unrepresentable rather than
checked.

The Bun host is the third implementation of `EpicenterBinding`
(`apps/epicenter/src/app-binding.ts`), so an application's background half runs
the same code against the same handle (ADR-0323).

## The surface

```ts
const epicenter = createEpicenter({ appId, definition, account, binding });

epicenter.appId              // string, frozen
epicenter.sqlite.open(name)  // Promise<Result<AppSqliteDatabase, AppError>>
epicenter.sqlite.delete(name)// Promise<Result<void, AppError>>
epicenter.secrets            // SecretStore
epicenter.account            // the AuthClient the application passed in
epicenter.state              // EpicenterState<TDefinition>, read-only
epicenter.open()             // Promise<Result<ReplicaData<TDefinition>, DataOpenError>>
epicenter.onStateChange(fn)  // () => void, the unsubscribe
epicenter.close()            // Promise<void>
epicenter.eraseReplica()     // Promise<Result<void, StoreError>>, closes first
```

```ts
type EpicenterState<TDefinition> =
	| { status: 'closed' }
	| { status: 'opening' }
	| { status: 'ready'; data: ReplicaData<TDefinition> }
	| { status: 'failed'; error: DataOpenError };
```

**`definition` and `account` arrive together or not at all.** An authority mints
every generation (ADR-0336), so there is no accountless store and no store
without sync. Pass neither and the handle has no `data` and no `account`, in the
type as well as at runtime; pass both and it has the superset.

**`appId` is explicit.** It normally matches `definition.id`, but the opening
application is an independent part of the store address. Keeping it explicit
means every handle states the scope it opens, including when it opens another
application's data.

**Construction is inert, and `open` is the only thing that acquires.**
`createEpicenter` claims no Web Lock, touches no IndexedDB, and makes no round
trip. `open` does all three, plus the sync dial and the flush-on-hide listener,
and an application calls it once from its root after authentication is ready.
`data` used to be a lazy getter whose READ started the open, which put
substantial asynchronous resource acquisition behind property syntax: an
application could not say when it happened, a surface could not retry it, and a
`{ ...epicenter }` anywhere claimed a lock.

`open` resolves a `Result`, and the error is the store's own rather than an
`AppError` wrapping it: `openFailure` switches on the failure's `name` to
choose the sentence a person reads and whether a retry can help. Two variants
are the session's rather than the store's.
`DataSessionError.SessionClosed` answers a caller whose open was closed
underneath, instead of handing back `Ok` over a store whose every verb throws;
`DataSessionError.OpenerThrew` contains an opener that rejected, which would
otherwise leave the session in `opening` with no way back.

**Repetition is deterministic, and each case is a different answer.** While
`opening`, callers join the one attempt. While `ready`, `open` resolves the
open store and acquires nothing. While `failed`, it RETRIES, which is what
makes "close the other window, then try again" a repair a person can perform
without reloading the document. After a `close`, it opens again.

**`close` is idempotent and returns the session to `closed`.** It is not
terminal: terminal was a property of the memo, and preserving it would need a
fifth state that only a hot reload and a test could observe. A close that lands
mid-open ends what that open acquired and publishes nothing for it.

**`state.data` is the typed application data and nothing else.** It carries no
`open`, no `close`, no `erase`, and no disposal, because the lock, the socket,
and the listener were acquired together and are released together (ADR-0340).
A component takes `state.data`; the lifetime stays with whoever built the
handle.

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

## Where an application puts this

Three places, and every Epicenter application uses the same three.

**One composition module, at module scope.** `src/lib/epicenter.svelte.ts`
holds `createEpicenter` beside `fromEpicenter` (`@epicenter/svelte`), exports
the adapted session, and closes the handle from its hot-reload disposer.
Nothing else can reach `close`, because the adapter does not forward it: the
document is the lifetime (ADR-0088), and the one caller that wants a shorter
one is the module being replaced.

**One boot node, which calls `open`.** It is the narrowest node that is not
shared with `/auth/callback`, because that route must claim no Web Lock, touch
no IndexedDB, and make no round trip on its way through (ADR-0345). Whichever
node that is, it reads `auth.state` once, calls `open` when the read is not
signed out, and renders the four states. Honeycrisp and Vocab boot from
`routes/+page.svelte` because their protected surface is one route at `/`;
Whispering boots from `routes/(app)/+layout.svelte` because it has a shell and
two siblings that must escape it.

**Two shared screens, taking the application's nouns.** `SignInScreen` and
`CannotOpenScreen` (`@epicenter/app-shell/boot-screens`) render signed-out and
`failed`; the boot node lends them `appName` and `noun`, which are the words
that are the application's, and keeps nothing else (ADR-0244). `openFailure`
turns a store refusal into the sentence and the repair a person is offered. A
failure earns its own sentence only by changing what a person can DO, which is
two of them: `AlreadyOpen`, because they can close the other window, and
`LocksUnsupported`, because a retry button there would be a lie.

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
