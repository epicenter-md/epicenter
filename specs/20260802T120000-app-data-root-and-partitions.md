# App-data root and app-owned partitions

- **Status:** Draft
- **Date:** 2026-08-02
- **Program:** greenfield breaking replacement
- **Decision owner:** [ADR-0201](../docs/adr/0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (provisional number)
- **Depends on, not in this tree:** ADR-0191 (mail engine in the host process) is
  on `claude/local-mail-in-epicenter`. Waves 4 and 5 assume it has merged. Waves
  1 through 3 do not.

## Product sentence

Epicenter stores everything it stores on a machine under one root. An app gets
one directory below it and partitions that directory by an identifier the
external authority owns.

## Accepted premises

- There is no user data to preserve. Both mirrors are rebuildable by definition,
  and no `intent.db` exists in any branch today.
- Both apps' users reconnect their accounts once. This is a breaking change and
  is not softened by a migration.
- Local Mail's partition rename requires the `openid` scope and therefore a
  re-consent. Waves 3 and 4 are not separable from that.

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

One new export, `@epicenter/constants/app-data`. That package is AGPL and
already holds cross-app platform contracts (app origins and ports, route
surfaces, provider credentials), which is what this is. It deliberately does not
go in `@epicenter/sqlite`: ADR-0197 kept per-tenant naming out of the mirror
primitive on purpose, and a path template there would reopen that.

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

## Waves

Each wave is one reviewable PR and leaves the repo green.

### Wave 1: the primitive

Add `@epicenter/constants/app-data` with the three functions and their tests.
Nothing consumes it yet.

Tests: the platform switch for darwin, linux with and without `XDG_DATA_HOME`,
and win32; `EPICENTER_DATA_DIR` precedence; every rejected segment shape;
`appDataDir` and `partitionDir` composition.

**Verification of the one fact a unit test cannot cover:** that
`epicenterDataRoot()` equals what Tauri's `app_data_dir()` returns for
`so.epicenter`. Print both on macOS and Linux and compare by hand, once, in this
wave. After Wave 5 deletes the Rust call there is nothing left to compare
against, so this is the only moment the check is possible.

### Wave 2: Local Books moves and gains its guard

- `resolveDataDir`, `defaultDataDir`, `LOCAL_BOOKS_DIR`, and `--data-dir` are
  deleted from `apps/local-books/src/paths.ts` and `config.ts`.
- `companyDir` becomes `partitionDir(appDataDir(root, 'local-books'), 'companies', realmId)`,
  which is where the missing validation arrives.
- `companies.json` keeps `defaultRealm` and loses `realms`; `resolveRealm` reads
  the directory.
- `.env.example` and the CLI help text drop the deleted variables.

Books first because it is the smaller change, has no identifier problem, and
proves the primitive against a real caller before Mail's harder wave.

Breaking: a user re-runs `local-books auth` and re-syncs. Say so in the PR body.

### Wave 3: Local Mail adopts `sub`

- `oauth.ts` requests `openid` alongside `gmail.modify` and reads `sub` from the
  ID token in the grant response.
- The token store keys accounts by `sub` and keeps `emailAddress` as a display
  field only. Every path that currently takes `accountEmail` as an identity takes
  a `GoogleAccountId` instead; the CLI still accepts an email and resolves it to
  a `sub` against the store, because a person types an address.
- `accountDir` is deleted in favour of the shared `partitionDir`.

Verify against a live Google consent screen that the ID token carries `sub` for
this client, before wiring anything to it. The docs are clear; the client's own
configuration is the part only a live run proves.

Breaking: every connected account reconnects. This is the wave that costs a user
something real.

### Wave 4: Local Mail moves under the root

Same deletions as Wave 2, for `LOCAL_MAIL_DIR` and `resolveDataDir`. Separate
from Wave 3 so that a failure in the scope change does not also revert the
layout, and so each PR has one reviewable subject.

If ADR-0191 has not merged, this wave still lands: the CLI resolves the root
itself and the standalone path is unaffected.

### Wave 5: the host injects, and Rust stops computing

- `apps/epicenter/src/main.ts` calls `epicenterDataRoot()` instead of reading
  `process.env.EPICENTER_DATA_DIR` directly, and passes
  `appDataDir(root, 'local-mail')` into the mail engine it composes.
- `apps/epicenter/src-tauri/src/lib.rs` stops calling `app_data_dir()` and stops
  setting `EPICENTER_DATA_DIR`. `app_log_dir()` and `app_config_dir()` are
  untouched; `app_data_dir` has exactly one caller today (line 1007).
- Tests that set `EPICENTER_DATA_DIR` keep working unchanged, because the
  override survives.

Requires ADR-0191. Without it there is no in-process mail engine to inject into,
and the wave reduces to the Rust deletion alone, which is still correct and can
land on its own.

## Explicitly out of scope

- Any migration, move, or copy of the old directories. They are left as inert
  disk (ADR-0201).
- Deleting the old directories. Code that removes a directory it cannot prove it
  wrote is the hazard the grammar exists to prevent.
- `intent.db` and the reconciler. Those are ADR-0198 and ADR-0199, and this spec
  exists partly to land before them.
- Automatic reclamation. Still blocked on quiescence (ADR-0197).
- A capability namespace, a host registry, or any generic database framework.

## Done means

- No app computes an OS application-data path.
  `git grep "Application Support" -- 'apps/*/src'` returns nothing; the only
  platform switch in the repo is in `@epicenter/constants/app-data`. Local Mail's
  `test-support/*.sh` helpers point at the old location and are updated with it;
  a Whispering JSDoc example mentioning the phrase is unrelated and stays.
- `git grep -E "LOCAL_(MAIL|BOOKS)_DIR"` returns nothing outside
  `apps/local-mail/test-support/`, which is retargeted in Wave 4.
- No path segment reaches `join` from an external source without passing
  `partitionDir`.
- The host and the CLI, run on one machine, operate on the same mailbox. Prove
  it: `local-mail status` from a terminal while Epicenter is open reports the
  artifact the host is syncing.
