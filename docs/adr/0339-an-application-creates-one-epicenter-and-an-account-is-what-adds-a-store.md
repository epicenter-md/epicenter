# 0339. An application creates one epicenter, and an account is what adds a store

- **Status:** Proposed
- **Date:** 2026-09-02
- **Unbuilt:** nothing. Built with two corrections this record now carries: the two names an application mints are branded, and the root is not types only.
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
		open(name: DatabaseName): Promise<Result<AppSqliteDatabase, AppError>>;
		delete(name: DatabaseName): Promise<Result<void, AppError>>;
	};
	readonly secrets: {
		put(label: SecretLabel, value: string): Promise<Result<void, SecretError>>;
		get(label: SecretLabel): Promise<Result<string | null, SecretError>>;
		delete(label: SecretLabel): Promise<Result<void, SecretError>>;
	};
} & ([TDefinition] extends [never]
	? {}
	: {
			readonly account: AuthClient;
			readonly data: Promise<
				Result<ReplicaData<TDefinition>, StoreError | DataDefinitionParseError>
			>;
			eraseReplica(): Promise<Result<void, StoreError>>;
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

**`data` is a lazy getter that memoizes, resolves already syncing, and resolves
a `Result`.** Reading it starts the open, so an application that never reads it
pays no Web Lock, no IndexedDB, and no round trip. Sync attaches inside, because
the account is on the handle.

**The error is the store's own, not `AppError.StorageFailed` wrapping it.** An
application's boot gate switches on the failure's `name` to choose between a
retry and an erase; `apps/honeycrisp/src/lib/boot-failure.ts` had arms for
`AlreadyOpen`, `Unaddressable`, and `BoundElsewhere`, and `openClientOwnedData`
flattened all of them into `AppError.StorageFailed({ cause })`, so every arm
fell through to "Something went wrong" and both repairs disappeared. The
`Unaddressable` arm went for a different reason, below: the wrapper answers its
one remaining producer.
`data` resolves `Result<…, StoreError | DataDefinitionParseError>`, which is what
`openDatabase` and `resolveGeneration` already return. `AppError` was minted for
the SQLite and secrets owners and is the wrong error for a store `packages/data`
opens.

**Honeycrisp's openers rejected instead, and the reason leaves with the
construct that justified it.** The comment in `databases.ts` is exact: a route
rendering a promise already has `{#await}`'s failure channel, so a `Result` past
the opener bought a second one, and the account route rendered its gate from four
arms of which none read the error. The Svelte wrapper removes `{#await}`. Its
`state` is synchronous tracked state read by `{#if}`, which has no failure
channel, so a rejection there is data that had to be caught and re-typed as
`unknown`. A `Result` is that data, already typed. Nothing past the wrapper
carries a `Result`, and nothing past it throws.

**`openData` leaves the binding.** What a runtime supplies is
`{ open, delete, secrets }` and nothing else. The Bun host keeps this seam,
because it composes a storage root and a secrets owner its test swaps; the two
window leaves keep it because a tab has no keychain and no Bun-owned files.

**`account` is an `AuthClient` the application constructs and passes in.** The
package does not build one. A desktop leaf needs its own bootstrap and a browser
leaf needs a redirect launcher, and a package that built both would have to know
every auth model an application might use.

**`data` opens the newest generation this device holds, else the authority's
newest, else mints, and nothing stores a selection.** The choice stays derived,
so deleting the generation from the URL takes nothing with it. There is no verb
that selects an older generation and there is no picker: every account has one
generation until `importReplica` ships, the ledger records numbers and nothing
else (ADR-0287 deleted the rest), and the one act an old generation supports is
export, which a browser cannot do yet (ADR-0325). When that changes the surface
is a read-only `generations.list()` and an exact `generations.open(n)` for a
rescue, each one existing function made public. Neither is decided here.

**The handle has no verb that creates a generation, and that is a statement
about now rather than about the shape.** `createGeneration(definition, { appId,
from, account })` already takes the bytes and already mints a number; nothing
outside `resolveGeneration`'s empty-first-run arm calls it, so every account
holds generation 1 and the second one cannot yet exist. A handle method with no
caller would be a promise made in a type instead of in prose, so the promise is
here.

**Two things must land together when it does.** An import must end with the
application reloading, because `data` is memoized and the store a page holds
after an import is still the one it opened; ADR-0293's "redirect to the
generation's URL" becomes a document reload, after which `data` resolves the new
number itself. And a device holding an older generation must be told a newer one
exists, because cache-first resolution means a second device that holds
generation 3 opens 3 on every boot without ever asking the authority. That is
ADR-0281's notice, specified there and never built, and this record is what
makes it load-bearing: deleting `/account/[generation]` removes the only other
way a person could reach a newer number. Neither is built here, and shipping an
import without the notice would strand a device silently.

**A name is checked where it is minted, and the type carries that.**
`DatabaseName` and `SecretLabel` are branded, and the six per-call guards inside
the handle are gone. They answered one question about a string that, in every
caller, is either a constant in the build or a value the application already had
to validate to say anything useful about: Local Mail's `finishConnect` already
refused a subject it could not file, because "we cannot file your mail under
that" is a sentence only the application can write. `databaseName` and
`secretLabel` mint one and throw, on the same terms `createEpicenter` throws on
an application id; `isDatabaseName` and `isSecretLabel` narrow a value that
arrived at runtime. The desktop owner still validates on arrival, because a
brand is a compile-time fact and a request crossing the sidecar carries no
types.

**Two renames follow from putting `account` on the handle.** `eraseLocalData` is
`eraseReplica`, because it erases this device's copy and touches nothing at the
authority (ADR-0325), and `replica` is the word a developer reads unsoftened.
`secrets.put(accountId, …)` becomes `secrets.put(label, …)` with
`SecretError.InvalidSecretLabel`, because ADR-0310 calls it a label and
`epicenter.account` now means something else on the same object.

**The Svelte wrapper has four states, and the data rides on `ready`.**
`fromEpicenter(epicenter)` answers `signed-out | opening | ready | failed`.
Signed-out is answered before anything opens, from a single read of
`account.state` (ADR-0088: a page lifetime is one auth generation), so a person
who cannot open anything costs no Web Lock, no IndexedDB, and no round trip. It
is its own state rather than a failure because the route already says so: folding
it into the failure channel makes the gate sniff an error to choose between "sign
in" and "something broke", and a signed-out open refuses with `Unaddressable`,
which the boot gate reads as a bad link.

It is the wrapper and not the handle that makes that read, and the layout's
reload gate is its precondition: an application that mounts no
`reloadOnAuthChange` signs a person in and leaves them on the sign-in screen
until they reload by hand.

The settled value is held in a `$state.raw` written from the promise's `.then`,
not a `createSubscriber`. A subscriber is for a source with a live read and a
subscribe pair, and its start function re-runs if every reader goes away and
returns; a promise settles once, cannot be unsubscribed, and must not be
forgotten because the last reader navigated away. The auth half of the same
wrapper does use `createSubscriber`, because an auth client is that kind of
source, so the two halves differ on purpose. That auth half is `reactive(auth)`
in `@epicenter/auth/svelte`, beside this wrapper rather than inside it:
`fromEpicenter` reads `account.state` once and tracks nothing.

There is no `app.data`. The opened store is a field on the `ready` variant, so a
read before the store is open does not compile. A top-level `data` accessor could
only be a runtime throw, which is a type turned into an invariant, and it cannot
be read from a `$derived` during `opening` without becoming a render error.

**This record assumes the opened store knows its own address.** The folder verbs
(ADR-0337) and the sync status a person is shown both need the generation, and
`ReplicaData` carried `baseURL` and `principalId` and no generation. With the
generation resolved inside `data`, an application cannot rebuild it. Putting the
address and the connection status on the store is a `packages/data` decision and
belongs in its own record; this one does not govern it and does not work without
it. That record is
[ADR-0340](0340-an-opened-store-knows-its-own-address-and-its-own-connection.md).

## Consequences

- An application states its id once and its definition once. The mismatched pair
  stops being representable, so nothing has to check for it.
- A handle with no type argument has no `data` and no `account`. Local Mail's
  three-line platform leaf is the whole surface it needs, and adding Epicenter
  Data later is one changed constructor call with every existing `sqlite` and
  `secrets` call site untouched.
- `resolveGeneration`, `attachStoreSync`, and the hand-built `DatabaseAccount`
  leave application code. Honeycrisp's `resolveAccountGeneration`,
  `honeycrispAccount`, and `sync.ts` are deleted. Vocab and Whispering still
  hold copies of the first two, because neither is on the store yet (ADR-0227
  left both broken on purpose); they go when those applications are rebuilt
  against the handle, and until then they are the only callers of
  `attachStoreSync` outside `packages/app`.
- The generation stops being a route parameter. `data` resolves it, so
  `/account/[generation]` and the `/account` page that only redirects into it
  both go. Nobody chose that number and no link carries it.
- An application constructs nothing from the `@epicenter/app` root: every
  `createEpicenter` an application calls lives under a runtime subpath. The root
  is not types only, which this record claimed and the build corrected twice
  over. It holds the errors, the two name mints and their guards, and the
  binding-taking `createEpicenter` the Bun host's leaf composes
  (`apps/epicenter/src/app-binding.ts`, which nothing in `main.ts` wires yet:
  ADR-0323's background half is a leaf and a test).
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
- **Downloading and holding every generation the authority lists, deleting the
  older local copies.** Refused. A generation is a whole database rather than a
  delta, a held copy is not a synced one because sync attaches to an open store,
  and this origin's persistence request is often refused, so extra copies raise
  the odds of an eviction that takes the generation a person actually uses.
  Deleting the older copy is the drain-and-switch ADR-0281 removed, aimed at the
  one copy holding a stranded device's work.
- **Rejecting rather than resolving a `Result`.** Refused. A rejection is
  `unknown`, so the failed state could not carry a typed error without an
  assertion, and `data` would be the only verb on a handle whose `sqlite.open`
  returns a `Result` that fails a different way.
- **Wrapping the store's failure in `AppError.StorageFailed`.** Refused. It hides
  the `name` a boot gate switches on under `cause`, which makes every arm the
  fallback and deletes the erase and retry repairs.
- **A top-level `data` accessor that throws before the store opens.** Refused. It
  converts a fact the type could carry into a runtime invariant, and it cannot be
  read from a `$derived` while opening.
- **`data` as a method taking the definition.** Refused. An application has one
  definition and it is an import, so the argument is a build-time constant
  arriving at call time, which is the same shape as the app id arriving twice.
