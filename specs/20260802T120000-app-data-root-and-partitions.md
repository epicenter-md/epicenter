# App-data root, app-owned partitions, and app-owned provider accounts

- **Status:** In Progress
- **Date:** 2026-08-02, extended 2026-08-03
- **Program:** greenfield breaking replacement
- **Decision owners:** [ADR-0201](../docs/adr/0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (the root, the levels, and the partition identifier) and [ADR-0202](../docs/adr/0202-a-provider-account-belongs-to-the-app-whose-durable-state-it-names-and-epicenter-brokers-none.md) (who owns the grant that names a partition, and which apps own a directory at all). Both numbers are provisional.
- **Depends on, not in this tree:** ADR-0191 (mail engine in the host process) is
  on `claude/local-mail-in-epicenter`. Wave 5a assumes it has merged for half its
  scope. Waves 1 through 4 do not depend on it.

## Product sentence

Epicenter stores everything it stores on a machine under one root. A
host-composed engine gets one directory below it and partitions that directory by
an identifier the external authority owns, and it holds the provider grant that
names each partition. The directory is a place, not an inter-app API: no app
receives a path into a peer's, and a fact reaches another app only as a verb the
owner publishes or a fact a person promotes into the shared replica. Epicenter
brokers no third-party grant and keeps no registry of them.

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
- **Only a composed engine owns a directory, and the closed `APP_DATA_IDS` union
  is what says so.** An admitted static app (ADR-0179) receives none, reaches
  durable state through the replica, and holds no provider grant. No wave below
  widens that set, and Wave 6 exists to keep the two id namespaces from
  colliding while it stays narrow.
- **No wave introduces a host-side account surface.** No registry, no shared
  token store, no connect/disconnect/refresh/revoke at the host, and no
  `epicenter.accounts` namespace (ADR-0202).

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

A table transcribed from someone else's source is a claim, not a check. Wave 5a
turns it into one: `src-tauri/src/app_data.rs` builds a Tauri app with the
identifier read from `tauri.conf.json`, asks the real `PathResolver` for
`app_data_dir()`, runs `epicenterDataRoot()` through Bun, and asserts the two
strings are equal. It proves the row for whichever platform it runs on, which is
the most any check here can do, and it fails on a `dirs` bump or an edited
identifier instead of splitting a person's data quietly.

## Waves

Each wave is one reviewable PR and leaves the repo green.

### Landed: waves 1 through 5a

- **Wave 1, the primitive.** `@epicenter/constants/app-data` holds
  `epicenterDataRoot`, `appDataDir`, and `partitionDir`, with the platform table
  and every rejected segment shape as unit tests. The comparison a unit test
  could not make is no longer a manual print: Wave 5a turned it into a test that
  builds a Tauri app with the real bundle identifier, asks its `PathResolver`
  for `app_data_dir()`, and compares that to what Bun returns from
  `epicenterDataRoot()` on the same machine.
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

- **Wave 5a, the sidecar resolves its own root.** `apps/epicenter/src/main.ts`
  calls `epicenterDataRoot()`; `lib.rs` stops calling `app_data_dir()` and stops
  setting `EPICENTER_DATA_DIR` for the child. `publish-app-catalog.ts` lost its
  `--data-dir` flag with the same argument that deleted `LOCAL_BOOKS_DIR`: a
  script that can name a different root than the running host publishes a
  generation nothing selects.

  The recorder's call survived, moved into `src-tauri/src/app_data.rs`, and grew
  the override rule on the way. That was forced rather than chosen. While Rust
  passed the root down, an ambient `EPICENTER_DATA_DIR` was overwritten and
  could split nothing; once the sidecar honours it, a recorder that only knew
  the platform default writes recordings to a `blobs/` the host does not serve.
  So the one remaining Rust resolution applies the same two rules, empty means
  unset and relative is refused, and its tests cover both branches.

  The check the recorder needed is the cross-language one described above,
  rather than the record-and-read-back smoke this section originally asked for.
  It is strictly better: it runs without audio hardware, covers the override
  branch as well as the platform one, and names the drift in a diff rather than
  in a missing recording. A live record-and-play-back on a built desktop is
  still worth doing once, and is listed under what remains.

  The mail-engine half did not apply. ADR-0191 has not merged into this tree:
  `mail` and `books` are placeholder surface pages here, and no mail engine is
  composed in `apps/epicenter/src`, so there is nothing to pass
  `appDataDir(root, 'local-mail')` into yet.

Who eventually owns the recorder's root is still a separate question and is
still not decided. Until it is, one Rust resolution remains and the equality
test is what keeps it honest.

The third participant in that same undecided question stayed put and is now
documented where it lives: `apps/whispering/src/lib/services/fs-paths.ts`
resolves `<root>/blobs` in the WebView through Tauri's `appDataDir()`. It is not
a peer-directory violation, since `blobs/` is the host's own directory and not an
app partition, and it is not an independent implementation either: `appDataDir()`
is an IPC call into the same `PathResolver::app_data_dir` the recorder uses, so
it agrees on the platform default by construction. What it cannot see is the
override, because a WebView cannot read the process environment, so under one
`EPICENTER_DATA_DIR` the "open the blobs folder" button opens the platform
default while the recordings are elsewhere. Closing that needs the host to hand
the WebView something, which is the wave that settles the recorder's root.
Giving it a native verb of its own now would buy a command, a capability entry,
and a binding, ahead of the decision that says who owns the value.

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

### Wave 6: an app id that names a place is not available to a folder

Independent of 5a and 5b, and small. Catalog admission reserves
`Object.keys(SURFACE_ROUTES)` today (`home`, `whispering`, `honeycrisp`, `mail`,
`books`), so a folder named `local-mail` is admissible. It is harmless only
because an admitted surface receives no directory, which is exactly what makes it
the kind of defect that stays invisible until somebody widens the directory rule.

- `apps/epicenter/src/main.ts` and `apps/epicenter/scripts/publish-app-catalog.ts`
  both pass `reservedIds`. Both take the union of `SURFACE_ROUTES` keys and
  `APP_DATA_IDS`, from one shared expression rather than two hand-written lists.
- `apps/epicenter/src/app-catalog.test.ts` gains a case: a folder named
  `local-mail` is not a catalog member.

No behavior a person can see changes. This closes ADR-0202's one named latent
collision before a later widening can reach it.

### Wave 7: one override for one root, and credentials stay at the app root

`LOCAL_MAIL_DIR`, `LOCAL_BOOKS_DIR`, and `--data-dir` are gone. Two overrides
survive that move a credentials file out from under the app root:
`LOCAL_MAIL_TOKEN_FILE` and `LOCAL_BOOKS_TOKEN_FILE`. They contradict ADR-0201's
"credentials stay at the app root" and "one override for one root, not one per
app", and the reason to take them seriously is that their producers are test
harnesses rather than people.

- Delete both variables, their `config.ts` resolution, their CLI help lines, and
  their `AGENTS.md` and `README.md` entries in both apps.
- Retarget every producer to `EPICENTER_DATA_DIR` pointed at a temp root, which
  is the shape `apps/local-books/test/helpers.ts` and Local Mail's `tempDir()`
  already use, and which additionally proves the app looks where the root says.
  Producers today: `apps/local-mail/src/cli.test.ts`,
  `apps/local-books/src/token-store.test.ts`,
  `apps/local-books/test/cli-e2e.test.ts`,
  `apps/local-books/test/grill-e2e.test.ts`,
  `apps/local-books/test/mcp-server.test.ts`, and
  `apps/local-books/test/demo-e2e.ts`.
- `LOCAL_MAIL_ACCOUNT` and `LOCAL_BOOKS_QB_REALM` stay. They select a partition,
  not a path, and nothing about them contradicts either record.

Honest cost, stated because it is the one thing here a person could notice:
Local Books' `AGENTS.md` currently advertises the token override for "any custom
location". Deleting it removes a documented capability from an app with no
released install, and the replacement is moving the whole root.

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
- Extracting the two apps' near-identical OAuth plumbing. Deferred to a third
  composed engine with a loopback provider, and then as a library the app calls,
  never a service it registers with (ADR-0109, ADR-0202).
- Any host-side account surface: a connected-provider registry, a shared
  refresh-token store, a cross-app connect or disconnect, or an
  `epicenter.accounts` namespace. A read-only Home view over each engine's
  existing status verb is the sanctioned escape hatch and is built only when a
  person asks for it (ADR-0202).
- A directory for an admitted static app, and any widening of `APP_DATA_IDS`.
  Promotion to a composed engine is a reviewable change to a closed union, not a
  wave here.
- Rebuilding ADR-0074's synced secret vault. Its primitives are deleted from the
  tree, its scope is now brought values only, and Whispering's device-local
  plaintext facade is the correct shipped degenerate until a product answer
  arrives.

## Done means

- No app computes an OS application-data path for its own data. The only platform
  switch in the repo is in `@epicenter/constants/app-data`, and
  `git grep "Application Support" -- 'apps/local-mail/src' 'apps/local-books/src'`
  returns nothing. Whispering's `<root>/blobs` resolution is out of scope; it is
  documented in `fs-paths.ts` and waits on the wave that settles the recorder's
  root.
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
- `git grep -E "LOCAL_(MAIL|BOOKS)_TOKEN_FILE"` returns nothing, and both apps'
  test harnesses isolate themselves with `EPICENTER_DATA_DIR` alone.
- A catalog folder named `local-mail` or `local-books` is refused by admission,
  proved by a case in `apps/epicenter/src/app-catalog.test.ts`, and the reserved
  set is one expression that both admission call sites read.
- No host code holds a third-party grant.
  `git grep -iEl "gmail\.modify|quickbooks|intuit|accounts\.google\.com" -- apps packages`
  outside the two engines finds only the landing pages and
  `packages/constants/src/provider-credentials.ts`, which resolves an app's own
  client credentials by name and states in its own header that no package
  accretes knowledge of every app's providers. Note that Epicenter's own OAuth
  in `packages/auth` and `packages/server` is a different credential (ADR-0188
  distinguishes them) and is not what this criterion is about.
- The `epicenter` handle in `packages/app/src/index.ts` still has exactly `data`,
  `recording`, and `transcription`. No `accounts`, no `storage`, no `providers`.
