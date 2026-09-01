# local-mail

Gmail in Epicenter. Local Mail pulls a Gmail account into a disposable local
cache with full pulls plus incremental `history.list` polling, records triage
acts as durable local assertions, and delivers them back to Gmail from one
reconciler per account.

It is a first-party Epicenter application and nothing else (ADR-0317). There is
no CLI, no MCP server, no HTTP API, and no standalone Bun or Tauri runtime. The
human workflow is the application: connect an account, look at the mailbox,
triage it, reconcile, and disconnect.

## Three concerns, three owners

| | What it is | Where it lives | If you lose it |
| --- | --- | --- | --- |
| which accounts are connected | a person's own data | Epicenter Data | reconnect each account |
| the mail itself | borrowed data | `openSqlite('mail')`, disposable | nothing but quota; re-pull |
| the credential | a secret | the host's keychain, never synchronized | reconnect that account |
| undelivered triage | a person's own act | `openSqlite('intent')`, durable | real work, unrecoverably |

All four are reached through one scoped handle (ADR-0316):

```ts
const epicenter = createEpicenter({
	appId: 'so.epicenter.local-mail',
	binding, // resolved by the build's `#platform/epicenter` condition
});
```

**The account id is the row id Epicenter Data minted.** Google's `sub` is
recorded beside it as `providerAccountId`, because Google documents `sub` as
stable while an address may change; the address is display metadata. Every mail
row, every intent row, and every secret is keyed by the Epicenter row id, so a
renamed mailbox moves nothing and an email address is never a path segment.

**Two SQLite databases, because their deletion policies differ.** `mail` may be
cleared and pulled again at any moment (ADR-0306). `intent` holds triage a
person performed that Gmail has not been told about, and nothing can rebuild it.
`mailbox.reset()` holds no handle to `intent` and cannot reach it.

## The write model

There is one model, and this is it (ADR-0198, ADR-0199).

**A triage act writes a durable assertion, not a Gmail call.** Acting on a
message records one row per touched label: a partial map from (message id, label
id) to want or do-not-want, per account. Ids only, never names, because Gmail's
label ids are immutable and its names are editable display strings. The map
holds opinions only about labels a person touched, so it never claims a whole
desired label set, and it is keyed so re-asserting a pair overwrites it. Archive,
then un-archive, then archive is one row.

**One reconciler per account is the only thing that writes to Gmail.** It drains
the account's assertions, retires each one Gmail confirms, then pulls Gmail's
facts. Running a pass requires the account's claim as a value rather than as a
promise the caller made: `reconcileAccount` takes what `claimReconcile` mints,
so delivering and pulling cannot interleave.

**Reversal is a new assertion.** Undo asserts the opposite want on the same key.
Nothing retires an assertion by comparing it to the cache: the cache lags Gmail
and can be incomplete, so a "the cache already agrees" rule would drop real
writes on stale evidence. Only provider confirmation retires an assertion.

**Undelivered work is visible and discardable.** Status reports the undelivered
count and the age of the oldest. `discardAll` abandons every undelivered
assertion; it cannot un-send one already delivered. There is no attempt counter,
no per-row error, no retry schedule, no dead-letter tier, and nothing expires.
Retries are bounded by a human, which is what discard is for.

**Reads apply the overlay.** A page of the triage list is Gmail's facts with
this machine's undelivered assertions applied, computed in SQL so filtering,
ordering, and paging are all post-overlay: an archived message leaves the inbox
page immediately and the page still comes back full.

## Shape

| Module | What it owns |
| --- | --- |
| `database.ts` | the account registry's Epicenter Data definition |
| `storage.ts` | the app id, the mirror folders, and both SQLite schemas |
| `accounts.ts` | the registry, connect, disconnect, and one account's session |
| `handle.ts` | the one way both stores read and write their database |
| `mailbox.ts` | one account's slice of the disposable cache, and the overlay |
| `intent-store.ts` | one account's slice of the durable assertions |
| `assert.ts` | the act path: entirely local, resolves label names to ids |
| `reconcile.ts` | the one Gmail writer: drain, then pull |
| `reconcile-claim.ts` | who may run a pass, and what that does not promise |
| `sync.ts` | full pull and incremental `history.list` folding |
| `oauth.ts` | the authorization-code and PKCE flow, as a page performs it |
| `token-manager.ts` | the live access token over the stored refresh token |
| `gmail-client.ts` | the Gmail transport, with backoff and one-shot refresh |
| `schema.ts` | the Gmail shapes this application reads |

## Where the desktop and the browser differ

One application, built twice (ADR-0310). The difference is two typed failures
rather than any branch in application code.

- **Secrets.** The desktop leaf reaches the OS credential store through the
  host; the browser leaf holds a credential for the life of the tab and nothing
  longer. Not `localStorage`, not IndexedDB, not encrypted in the page.
- **Background synchronization.** A keychain and a hidden window are what buy
  it, and a browser tab has neither, so the web build syncs while a person is
  looking at it.

### The registry does not synchronize yet

ADR-0310 describes an account list that reaches a person's other devices while
its credentials do not, so a new device shows every account asking to be signed
in. That half is unbuilt. `epicenter.openData` opens a device-local document,
which by its own definition never receives a foreign byte, so today the account
list is per device and a second device starts empty.

The credential half is real and is the half that matters for safety: a refresh
token never leaves the device that obtained it. Making the list synchronize
means opening the account overload of `openDatabase`, which needs the signed-in
principal the host brokers, and that is a decision about which authority an
application's own data belongs to.

## Testing

```sh
bun test --cwd apps/local-mail
```

Everything is hermetic: the tests run against in-memory SQLite through the same
`AppSqliteDatabase` contract the host and the browser implement, and against a
fake Gmail client. `test-support/check-gmail-discovery.ts` is the one live
check, and it runs weekly rather than per pull request.

## Not built yet

- **Remote image loading and Gmail-perfect HTML fidelity.** Formatted bodies
  render as sanitized inline HTML; remote assets stay stripped.
- **Enumeration surfaces.** Thread and bulk acts, and asserting `UNREAD` off
  when a message is opened. The semantics are already fixed: enumerate concrete
  message ids at the moment a person acts, never at delivery time.
- **Gmail-backed drafts, send, reply, and compose.** Allowed in principle only
  for drafts, which round-trip (ADR-0098); shipping send would widen the OAuth
  grant past `gmail.modify` (ADR-0188).
- **FTS5.** `LIKE` over `body_text` is enough at current cache size.
- **An MCP surface.** Explicitly deferred (ADR-0317). It must enter through a
  designed application service, not through a compatibility path.

## Refused

These are decisions, not gaps. Each has a record, and adding one back is an ADR
rather than a pull request.

- **A CLI, an HTTP API, and a standalone runtime** (ADR-0317). Each was a second
  storage and credential owner beside the scoped handle. Arbitrary SQL access
  and command-line-only recovery do not survive that break; a workflow that
  remains necessary earns a UI.
- **Local-only mail state**: snooze, send-later, and a local tag or read flag
  that never reaches Gmail (ADR-0098). A pending assertion is not an exception:
  it names a Gmail label id and exists in order to stop existing.
- **Permanent delete and spam reporting.** `messages.delete` is never wired: a
  deferred, discardable, silently-retried intent is the wrong shape for an
  irreversible act (ADR-0198).
- **Attachment and media bytes on disk, in any form.** One
  `messages.get(format=full)` is the entire per-message budget (ADR-0196).
- **Thread-level modify.** `threads.modify` applies to the thread as Gmail sees
  it at delivery, which would silently include messages that arrived after a
  person acted (ADR-0199).
- **`messages.batchModify`.** Its response body is empty, so it proves nothing
  about which assertions landed (ADR-0199).
- **A generic queue, event log, or provider-independent operation abstraction**,
  and any per-assertion attempt counter, error column, retry schedule, or
  dead-letter tier (ADR-0198, ADR-0199).
- **A credential brokered by a server** so a browser build could sync in the
  background. It would mean Epicenter's server holding something that reads a
  person's mail, which changes what Epicenter claims to be (ADR-0310).
- **Reading or migrating the old layout.** `credentials.json`, `provider.json`,
  the versioned `mail.v<n>.db` artifacts, and the per-account directories are
  not read, not migrated, and not detected. Connecting an account again is the
  whole of the upgrade path.
