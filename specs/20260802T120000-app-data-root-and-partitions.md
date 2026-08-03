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

- **A Local Mail partition holds one irreplaceable file.** ADR-0198 and ADR-0199
  are built, not proposed: `apps/local-mail/src/intent.ts` and the account
  reconciler are in this tree. The earlier draft of this spec assumed no
  `intent.db` existed and sequenced itself to land before one did. It did not,
  and Wave 4 carries the consequence.
- **Local Books users reconnect once and re-sync.** Its partition holds a
  version-named mirror and a lock, both rebuildable, so its move is a clean break
  with no migration code.
- **Local Mail users do not reconnect for the move, and do reconnect once for the
  identifier.** Wave 4 relocates credentials along with the partitions; Wave 5b
  costs the `openid` scope and one consent screen per account.
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
      companies.json                     default selection only
      companies/<realmId>/
        books.v1.db  lock.db
```

## The primitive

One new export, `@epicenter/constants/app-data`. That package is AGPL, both apps
already depend on it, and it already holds cross-app platform contracts (app
origins and ports, route surfaces, provider credentials), which is what this is.
It deliberately does not go in `@epicenter/sqlite`: ADR-0197 kept per-tenant
naming out of the mirror primitive on purpose, and a path template there would
reopen that.

```ts
/** The one Epicenter application-data root. EPICENTER_DATA_DIR wins. */
export function epicenterDataRoot(env?: Record<string, string | undefined>): string;

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

### Wave 1: the primitive

Add `@epicenter/constants/app-data` with the three functions and their tests.
Nothing consumes it yet, and that is deliberate: its first consumer is a
breaking change to where a person's books live, which deserves its own review.

Tests: the three platform rows above, including a relative `XDG_DATA_HOME` being
ignored; `EPICENTER_DATA_DIR` precedence and the empty-string case; every
rejected segment shape; `appDataDir` and `partitionDir` composition.

### Wave 2: Local Books moves and gains its guard

- `resolveDataDir`, `defaultDataDir`, `LOCAL_BOOKS_DIR`, and `--data-dir` are
  deleted from `apps/local-books/src/paths.ts` and `config.ts`.
- `companyDir` becomes
  `partitionDir(appDataDir(root, 'local-books'), 'companies', realmId)`, which is
  where the missing validation arrives. Today `realmId` reaches
  `join(dataDir, realmId)` unvalidated from both the Intuit callback and
  `--realm` (`apps/local-books/src/oauth.ts:158`, `src/paths.ts:34`).
- `companies.json` is deleted. It indexed which companies are connected, and
  `credentials.json` already is that index: the token store is keyed by
  `realmId`. `TokenStore` gains `listRealms()` and `resolveRealm` asks it, which
  is the shape Local Mail already has (`listAccounts` / `resolveAccount`). The
  recorded default goes with the file; `--realm` and `LOCAL_BOOKS_QB_REALM`
  cover the sticky case, and a sole connected company still resolves on its own.
- The CLI help text drops the deleted variables. `.env.example` holds only the
  Intuit keysets and is unaffected.

Books first because it is the smaller change, has no identifier problem, and
proves the primitive against a real caller before Mail's harder waves.

No migration code. A user re-runs `local-books auth` and re-syncs; say so in the
PR body. The legacy directory is left whole.

### Wave 3: Local Mail's data directory gets one owner

Preparation, not relocation, and it lands without a user-visible change.
`resolveDataDir` stays for one more wave, but every caller that joins a path
below it routes through `paths.ts`, so Wave 4 changes one function rather than a
scatter. Verify by grep: no `join(` on a data directory outside `paths.ts`.

### Wave 4: Local Mail moves under the root, carrying its partitions

The only wave with migration code, and the only one that reads a pre-move path.

- `LOCAL_MAIL_DIR` and the platform switch are deleted; the app resolves
  `appDataDir(epicenterDataRoot(), 'local-mail')`.
- On first run, if the legacy directory exists, move into the new one: the
  app-root files (`credentials.json`, `provider.json`) and each `<accountEmail>/`
  partition, which lands under `accounts/`. Every step is a `rename`. Nothing
  reads a database, nothing interprets a stored shape, and nothing is deleted:
  whatever the app did not put in the legacy directory stays there.
- The partition segment stays the account email in this wave. Relocation does not
  change identity, and bundling the two would put a gated, network-dependent step
  inside a mechanical move (ADR-0201).
- A partition that already exists at the destination is left alone and the legacy
  one is not moved over it.

The relocation code is deleted in the release after the one that ships it. Name
that in the PR body so the follow-up is not archaeology.

Tests: a legacy directory with two accounts, one holding undelivered assertions,
ends up under the new root with the assertions still readable and `status`
reporting the same count; a fresh install with no legacy directory does nothing;
a destination collision is refused rather than merged.

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
- **No partition is renamed.** The account starts an empty partition and
  re-pulls. An email-named directory cannot be proven to belong to the account
  that just authenticated, which is the defect being fixed (ADR-0201).
- `connect` refuses to complete the identity change while that account holds an
  undelivered assertion, reporting the count and the age of the oldest and naming
  `reconcile` and `discard --all`. Both already exist and both take the reconcile
  lock; nothing new is built.

Breaking: every connected account reconnects and re-pulls once.

## Explicitly out of scope

- Any migration of Local Books' directories, and any deletion of a legacy
  directory in either app.
- Interpreting stored bytes anywhere. Wave 4 moves directories and reads nothing
  inside them.
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

- No app computes an OS application-data path.
  `git grep "Application Support" -- 'apps/*/src'` returns nothing; the only
  platform switch in the repo is in `@epicenter/constants/app-data`.
- `git grep -E "LOCAL_(MAIL|BOOKS)_DIR"` returns nothing outside
  `apps/local-mail/test-support/`, retargeted in Wave 4.
- No path segment reaches `join` from an external source without passing
  `partitionDir`.
- No app names another app's directory. `git grep "appDataDir(" -- 'apps/*/src'`
  shows each app passing only its own id, and `epicenterDataRoot` is called at a
  composition root (`bin.ts`, `main.ts`) rather than from app logic.
- A Local Mail user who upgrades with pending triage still has it afterwards, and
  `status` reports the same undelivered count on both sides of Wave 4.
- The host and the CLI, run on one machine, operate on the same mailbox:
  `local-mail status` from a terminal while Epicenter is open reports the
  artifact the host is syncing.
