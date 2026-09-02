# 0339. An application creates one epicenter, and an account is what adds a store

- **Status:** Proposed
- **Date:** 2026-09-02
- **Unbuilt:** none of this exists. `packages/app` exports `createEpicenter({ appId, binding })` with `openData(definition, account)` as a method, plus `createBrowserBinding` and `createDesktopBinding`. `apps/honeycrisp` does not import the package at all.
- **Amends:** [ADR-0316](0316-an-application-creates-one-scoped-epicenter-handle.md) at "the composition is `openData`, `openSqlite`, and `secrets`" and at the handle's argument list. The scoped handle, its one name, and its refusal of `createAppRuntime` stand.
- **Relates:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) (account and store are one yes/no), [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md), [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md), [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md), [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md)

## Context

The handle asks an application to state its identity twice. Every construction
in the repository writes the app id into `createEpicenter` and again into the
binding it passes:

```ts
createEpicenter({ appId: LOCAL_MAIL_APP_ID, binding: createBrowserBinding({ appId: LOCAL_MAIL_APP_ID }) })
```

Nothing checks that the two agree. `createEpicenter` validates its id with
`isProtocolAppId` and throws; `createBrowserBinding` validates nothing. A
mismatched pair compiles and scopes the two halves to different applications,
and no type can forbid it, because TypeScript cannot say "this string and that
string are the same string."

The repetition is a symptom. The platform fork happens twice: once by the
package.json `imports` condition that selects `epicenter.browser.ts` or
`epicenter.epicenter-host.ts`, and again by argument, inside a file that only
exists on one platform.

`openData` is on the binding and does not vary. Both window leaves implement it
as the same `openClientOwnedData(appId, definition, account)` call, and the Bun
host refuses it outright, because the store is client-owned in every runtime
(ADR-0226, ADR-0227). One quarter of the seam is not a seam.

And the handle takes a definition per call while an application has exactly one.
The two applications that hold data (`apps/honeycrisp`, and `apps/vocab` and
`apps/whispering` when they return) each declare one definition whose data id is
their app id. The one application using the handle today (`apps/local-mail`)
declares none, has no `@epicenter/auth` dependency, and uses `openSqlite` and
`secrets` only.

## Decision

**An application creates one epicenter, and an account is what adds a store.**

The runtime is the import path. The name never carries it.

```ts
import { createEpicenter } from '@epicenter/app/browser';   // or '@epicenter/app/desktop'

createEpicenter({ appId }): Epicenter
createEpicenter({ appId, definition, account }): Epicenter<typeof definition>
```

```ts
type Epicenter<TDefinition extends DataDefinition = never> = {
	readonly appId: string;
	readonly sqlite: {
		open(name: string): Promise<Result<AppSqliteDatabase, AppError>>;
		delete(name: string): Promise<Result<void, AppError>>;
	};
	readonly secrets: {
		put(label: string, value: string): Promise<Result<void, SecretError>>;
		get(label: string): Promise<Result<string | null, SecretError>>;
		delete(label: string): Promise<Result<void, SecretError>>;
	};
} & ([TDefinition] extends [never]
	? {}
	: {
			readonly account: AuthClient;
			readonly data: Promise<ReplicaData<TDefinition>>;
			eraseReplica(): Promise<void>;
		});
```

**`definition` and `account` arrive together or not at all.** ADR-0336 settled
that an authority mints every generation, so there is no accountless store and
no store without sync. The overload is that sentence in the type: an application
that passes neither gets a handle with no `data` and no `account`, and one that
passes both gets the superset. `[TDefinition] extends [never]` fails downward,
so omitting the argument yields the smaller type rather than the larger.

**Five nouns at one altitude:** `appId`, `sqlite`, `secrets`, `account`, `data`.
Verbs live under the noun they belong to. `openSqlite` and `deleteSqlite` were
two verbs sharing a suffix, which is a noun that had not been written down.

**`data` is a lazy getter that memoizes, resolves already syncing, and
REJECTS.** Reading it starts the open, so an application that never reads it
pays no Web Lock, no IndexedDB, and no round trip. Sync attaches inside, because
the account is on the handle. It rejects rather than resolving a `Result`:
`packages/data` returns `Result` and should, but that type is for a caller who
branches on the error or composes it onward, and a route does neither. Every
failure here is terminal and renders one component, and `{#await}` already has a
failure channel. `openSqlite` keeps its `Result`, because Local Mail genuinely
branches on it.

**`openData` leaves the binding.** What a runtime supplies is
`{ open, delete, secrets }` and nothing else. The Bun host keeps this seam,
because it composes a storage root and a secrets owner its test swaps; the two
window leaves keep it because a tab has no keychain and no Bun-owned files.

**`account` is an `AuthClient` the application constructs and passes in.** The
package does not build one. A desktop leaf needs its own bootstrap and a browser
leaf needs a redirect launcher, and a package that built both would have to know
every auth model an application might use.

**Two renames follow from putting `account` on the handle.** `eraseLocalData` is
`eraseReplica`, because it erases this device's copy and touches nothing at the
authority (ADR-0325), and `replica` is the word a developer reads unsoftened.
`secrets.put(accountId, …)` becomes `secrets.put(label, …)` with
`SecretError.InvalidSecretLabel`, because ADR-0310 calls it a label and
`epicenter.account` now means something else on the same object.

## Consequences

- An application states its id once and its definition once. The mismatched pair
  stops being representable, so nothing has to check for it.
- A handle with no type argument has no `data` and no `account`. Local Mail's
  three-line platform leaf is the whole surface it needs, and adding Epicenter
  Data later is one changed constructor call with every existing `sqlite` and
  `secrets` call site untouched.
- `resolveGeneration`, `attachStoreSync`, and the hand-built `DatabaseAccount`
  leave application code. Honeycrisp's `resolveAccountGeneration`,
  `honeycrispAccount`, and `sync.ts` are deleted, along with the copies of the
  first two in Vocab and Whispering.
- The generation stops being a route parameter. `data` resolves it, so
  `/account/[generation]` and the `/account` page that only redirects into it
  both go. Nobody chose that number and no link carries it.
- `@epicenter/app` root becomes types only for an application. Every constructor
  lives under a runtime subpath.
- ADR-0337's folder verbs stay functions over an opened store rather than
  methods on the handle, because they belong to the store's address.

## Considered alternatives

- **`createBrowserEpicenter` and `createDesktopEpicenter`.** Refused. Putting the
  runtime in the name is naming the mechanism, which is what ADR-0316 refused
  `createAppRuntime` for, and it forces a second axis into the name the moment
  anything else varies. The import path already carries it.
- **`AppStorage` beside `Epicenter`, as two constructors.** Refused. The base
  name teaches the wrong lesson: a developer would learn "storage" first and
  "Epicenter" as the upgrade, when the reference application has all four parts
  and the accountless one is the documented exception (ADR-0319).
- **`files` or `databases` for the SQLite noun.** Refused. Both words are taken
  and a developer meets their other meanings the same day. `databases` is the
  synced store (`openDatabase`, `DatabaseName`), and `files` is the `~/Epicenter`
  working copy (ADR-0337, `CheckoutFile`).
- **An empty definition for an application with no store.** Refused. It is not a
  spelling: an empty definition still resolves a generation over the network and
  claims an exclusive Web Lock, so an application with no data would pay a cold
  round trip for a store with no tables.
- **`oauth` configuration in the constructor.** Refused. It would make
  `packages/app` depend on `@epicenter/auth`'s constructors and know the desktop
  bootstrap, to save one line in a file whose job is composing.
- **Opening eagerly at construction.** Refused. A module-scope handle whose
  `data` rejects for a signed-out person produces an unhandled rejection on any
  route that never reads it, and it claims the Web Lock during module
  evaluation, which a second tab and a hot reload both meet.
- **`data` as a method taking the definition.** Refused. An application has one
  definition and it is an import, so the argument is a build-time constant
  arriving at call time, which is the same shape as the app id arriving twice.
