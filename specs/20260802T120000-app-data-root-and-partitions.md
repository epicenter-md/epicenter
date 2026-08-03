# App-data root and app-owned partitions

- **Status:** In Progress
- **Date:** 2026-08-02
- **Program:** greenfield breaking replacement
- **Decision owner:** [ADR-0201](../docs/adr/0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (provisional number)
- **Depends on, not in this tree:** ADR-0191 (mail engine in the host process) is
  on `claude/local-mail-in-epicenter`. Wave 5a assumes it has merged for half its
  scope. Waves 1 through 4 do not depend on it.

## Product sentence

Epicenter stores everything it stores on a machine under one root. An app gets
one directory below it and partitions that directory by an identifier the
external authority owns. The directory is a place, not an inter-app API: no app
receives a path into a peer's, and a fact reaches another app only as a verb the
owner publishes or a fact a person promotes into the shared replica.

## Accepted premises

- **Neither app has a released install, so every path change is a clean break.**
  No wave reads a pre-record path, moves a directory, or copies a database. A
  person reconnects and re-syncs, in both apps and at both path changes.
- **A Local Mail partition holds one irreplaceable file, and that is an argument
  about the future.** ADR-0198 and ADR-0199 are built, not proposed:
  `apps/local-mail/src/intent.ts` and the account reconciler are in this tree.
  `intent.db` is why the partition needs an identifier Google promises to keep
  (Wave 5b). It is not a reason to carry development-state bytes across a path
  change; an intermediate draft of this spec argued that it was, built the
  relocation, and the relocation is deleted.
- **Local Mail reconnects once per path change**, so twice across this spec: at
  the root move and again at the identifier. Wave 5b additionally costs the
  `openid` scope and one consent screen per account.
- The mirrors are re-pulled when their partition is rebuilt, never migrated.

## Destination

```txt
<root>/                                  so.epicenter app data, or EPICENTER_DATA_DIR
  data/  blobs/  app-catalog/            unchanged
  apps/
    local-mail/
      credentials.json                   0600
      provider.json                      0600
      accounts/<google-sub>/
        mail.v5.db  intent.db  lock.db
    local-books/
      credentials.json                   0600
      companies/<realmId>/
        books.v1.db  lock.db
```

Four levels, and one rule produces all of them: **a directory level exists
exactly where naming authority changes hands.** Epicenter names the root and its
own directories, an app names everything in its directory, an external authority
names a partition. `apps/` is the first hand-off and the partition-kind
directory is the second, because a namespace whose next name is chosen by
somebody else cannot be defended by the party who would have to defend it.
Nothing here is a container for tidiness, and nothing else earns a level:
disposability is a property of a file, so it stays in ADR-0197's filename
grammar. Each level was collapse-tested against shipped code and kept
(ADR-0201).

## The primitive

One new export, `@epicenter/constants/app-data`. That package is AGPL, both apps
already depend on it, and it already holds cross-app platform contracts (app
origins and ports, route surfaces, provider credentials), which is what this is.
It deliberately does not go in `@epicenter/sqlite`: ADR-0197 kept per-tenant
naming out of the mirror primitive on purpose, and a path template there would
reopen that.

```ts
/** The one Epicenter application-data root. An absolute EPICENTER_DATA_DIR
 * wins; a relative one is refused. The ambient inputs are a value so the
 * platform table is a unit test. */
export function epicenterDataRoot(system?: DataRootSystem): string;

/** `<root>/apps/<appId>`. The app owns everything below the result. */
export function appDataDir(root: string, appId: AppDataId): string;

/** `<appDir>/<kind>/<partitionId>`, both segments validated. */
export function partitionDir(appDir: string, kind: string, partitionId: string): string;
```

`partitionDir` throws when a segment is empty, `.`, `..`, or contains a path
separator. That guard is the only reason the function exists rather than a bare
`join`, and it is what closes the unguarded `realmId` path today.

Three functions, no object, no class, no lifecycle. There is no
`StorageManager`, no `openAppStore`, no registry, and no `cacheDir`.

### What `epicenterDataRoot` must equal, and why it is a test

The desktop host's root is Tauri 2.11's `app_data_dir()`, which is
`dirs::data_dir()` joined with the `so.epicenter` identifier
(`tauri-2.11.5/src/path/desktop.rs:247`). `dirs` 6.0 resolves `data_dir()` as:

| Platform | Resolution                                                        | Source                     |
| -------- | ----------------------------------------------------------------- | -------------------------- |
| macOS    | `$HOME/Library/Application Support`                               | `dirs-6.0.0/src/mac.rs:12` |
| Linux    | `$XDG_DATA_HOME` **only when absolute**, else `$HOME/.local/share` | `dirs-6.0.0/src/lin.rs:11` |
| Windows  | `FOLDERID_RoamingAppData`, i.e. `%APPDATA%`                       | `dirs-6.0.0/src/win.rs:10` |

Both apps get two of those wrong today. Each accepts any non-empty
`XDG_DATA_HOME`, absolute or not, and neither has a `win32` branch, so a Windows
install lands in `%USERPROFILE%\.local\share\local-mail`. The resolver is a
correction, and each row above is a unit test rather than a hand comparison.

The one thing a unit test cannot prove is that a real Tauri build agrees. Print
`epicenterDataRoot()` beside `app.path().app_data_dir()` once, on macOS, in Wave
1. Wave 5a removes the sidecar's Rust call but not the recorder's, so the
comparison stays possible afterwards.

## Waves

Each wave is one reviewable PR and leaves the repo green.

### Landed: waves 1 through 4

- **Wave 1, the primitive.** `@epicenter/constants/app-data` holds
  `epicenterDataRoot`, `appDataDir`, and `partitionDir`, with the platform table
  and every rejected segment shape as unit tests. The one thing a unit test
  cannot prove is still open: nobody has printed `epicenterDataRoot()` beside a
  real Tauri `app_data_dir()` on macOS. That comparison stays possible after
  Wave 5a and is the check that keeps the recorder's `<root>/blobs` honest.
- **Wave 2, Local Books.** Moved to `<root>/apps/local-books`, `companyDir` runs
  through `partitionDir` (closing the unguarded `realmId` path), and
  `companies.json` is deleted in favour of the token store's `listRealms()`.
- **Waves 3 and 4, Local Mail.** Wave 3 turned out to be three lines rather than
  a wave: every name below the data directory already came from `paths.ts`
  except the presence file, which moved there. Wave 4 landed with it. The app
  resolves `appDataDir(epicenterDataRoot(), 'local-mail')`, `accountDir` is
  `partitionDir(dataDir, 'accounts', accountEmail)`, and `LOCAL_MAIL_DIR` and the
  platform switch are gone.

Neither Mail wave carries migration code. An intermediate pass built one, on the
reasoning that `intent.db` had shipped and a pre-record directory therefore had
to be carried forward: a relocation, a refusal for the deleted environment
variable, a rule for a destination collision, a rule for a lost race between two
surfaces, and a rule for a cross-filesystem rename. All of it was bought for
local development state on a product with no released install, and all of it is
deleted. What remains is the path change itself.

A pre-record directory is left whole and named nowhere in the tree, so there is
no transitional code to remove later and no one-release window to remember.
Durable intent is protected where it is actually at risk, inside a partition
under the new path, by the operations that already own it: `reconcile` delivers,
`discard --all` abandons, both under the account's reconcile lock, and `status`
reports what is owed.

### Wave 5a: the host injects, and Rust stops computing the sidecar's root

- `apps/epicenter/src/main.ts` calls `epicenterDataRoot()` instead of reading
  `process.env.EPICENTER_DATA_DIR` directly.
- `apps/epicenter/src-tauri/src/lib.rs:1007` stops calling `app_data_dir()` and
  stops setting `EPICENTER_DATA_DIR`.
- `recorder/blob.rs:107` keeps its call. It computes `<root>/blobs` in Rust for
  the staged-recording store, which runs before the sidecar could have told it
  anything. Prove the two still name one directory: record something, then read
  it back through the sidecar's blob store.
- Tests that set `EPICENTER_DATA_DIR` keep working, because the override
  survives.

Who eventually owns the recorder's root is a separate question and is not decided
here. Until it is, one Rust caller remains and the equality above is the check
that keeps it honest.

There is a third participant in that same undecided question, found while
auditing this wave: `apps/whispering/src/lib/services/fs-paths.ts` resolves
`<root>/blobs` for itself through Tauri's `appDataDir()`, inside the desktop host
only. It is not a peer-directory violation, since `blobs/` is the host's own
directory and not an app partition, but it is a third resolver for a path the
host already computes and injects elsewhere. Fold it into whichever wave settles
the recorder's root; doing it here would put a Whispering change inside a Books
and Mail move.

If ADR-0191 has merged, this wave also passes `appDataDir(root, 'local-mail')`
into the mail engine the host composes. If it has not, that half waits and the
rest still lands.

### Wave 5b: Local Mail adopts `sub`

The expensive wave, and the one that costs a user something real.

- `oauth.ts` requests `openid` alongside `gmail.modify` and reads `sub` from the
  ID token in the grant response. Verify against a live Google consent screen
  that the ID token carries `sub` for this client before wiring anything to it;
  the docs are clear, the client's own configuration is what only a live run
  proves.
- The token store keys accounts by `sub` and keeps `emailAddress` as a display
  field. Every path that takes `accountEmail` as an identity takes a
  `GoogleAccountId`; the CLI still accepts an address and resolves it against the
  store, because a person types an address. This is the wide part of the change:
  `config.account`, `resolveAccount`, `/api/accounts/:account/*`, the MCP account
  selection, and the SPA's account switcher.
- `accountDir` is deleted in favour of the shared `partitionDir`.
- **No partition is renamed, and none is read.** The account starts an empty
  partition and re-pulls. An email-named directory cannot be proven to belong to
  the account that just authenticated, which is the defect being fixed
  (ADR-0201), and the email-named directories that exist today are development
  state either way.

Breaking: every connected account reconnects and re-pulls once.

## Explicitly out of scope

- Any migration, relocation, or deletion of a pre-record directory in either
  app, and any code that names one.
- Interpreting stored bytes anywhere, including the app's own.
- A capability namespace, a host registry, a generic database framework, a
  migration runner, or a backup protocol.
- Any cross-app reader. No app receives a peer's path or handle, there is no
  host query verb taking an app id, and no permission model is built to say so:
  the boundary is an API rule between admitted first-party code, not a sandbox
  (ADR-0201).
- Automatic reclamation of mirror predecessors. Still blocked on quiescence
  (ADR-0197).
- Extracting `@epicenter/mirror`. Deferred to a third provider; two prototypes on
  open branches reached that conclusion independently.

## Done means

- No app computes an OS application-data path for its own data. The only platform
  switch in the repo is in `@epicenter/constants/app-data`, and
  `git grep "Application Support" -- 'apps/local-mail/src' 'apps/local-books/src'`
  returns nothing. Whispering's `<root>/blobs` resolution is out of scope and
  tracked under Wave 5a.
- `git grep -E "LOCAL_(MAIL|BOOKS)_DIR"` returns nothing. The test harness is
  retargeted to `EPICENTER_DATA_DIR`.
- No path segment reaches `join` from an external source without passing
  `partitionDir`.
- No app names another app's directory. `git grep -n "appDataDir(" -- 'apps/*/src'`
  shows each app naming only itself: one call in that app's own `paths.ts`, plus
  calls in that app's own tests placing a temp root, every one of them passing a
  literal app id and no parameter that could carry a peer's. A CLI resolves its own root there
  rather than threading it down from `bin.ts`: a parameter for it is the
  per-app-root plumbing this record deletes, and the id being a literal is what
  makes a peer's directory unnameable. The host's `main.ts` is the one place that
  resolves the root and injects it, because it composes surfaces it does not own
  (Wave 5a).
- No wave names a pre-record path. `git grep -rn "local-mail'" -- 'apps/local-mail/src'`
  finds the app id passed to `appDataDir`, and nothing that joins it to an OS
  data directory.
- The host and the CLI, run on one machine, operate on the same mailbox:
  `local-mail status` from a terminal while Epicenter is open reports the
  artifact the host is syncing.
