# An installed app owns a namespace: working ADR-0210 backward

- **Status:** Draft
- **Decides nothing.** The decision is [ADR-0210](../docs/adr/0210-an-installed-app-declares-its-name-and-the-namespace-it-owns.md). This is the sequence for building it, and it is deleted when the work lands.

## What is already true, checked rather than assumed

Publishing `apps/vocab` through the real `catalog:publish` boundary and booting
the host against that generation gave `/api/apps` a `vocab (Vocab)` entry and
`/apps/vocab/` a 200, while `/api/home/inspect` still answered with only
`so.epicenter.home` and `so.epicenter.honeycrisp`.

Two things were expected to be in the way. Only one is.

**The replica is already reachable.** `openDesktopEpicenter`
(`packages/data/src/desktop.ts:69`) is a same-origin `POST` with
`credentials: 'same-origin'`. An installed app is served from the one trusted
origin, so it can call that route with no build-time condition. The
`epicenter-host` condition selects which client a build imports and confers
nothing.

**The parser already exists.** `defineTable` takes plain JSON field schemas,
runs `recognize()` over each one, and throws on anything outside the `field.*`
vocabulary. `defineLens` checks the namespace grammar, the table names, and
case-insensitive duplicates. Reading a Lens from disk is
`JSON.parse` then those two functions. No new validation code.

**The one real gap:** the host's Lens list is a literal in `main.ts`, read by the
folder renderer, the projection, and the inspection source. Nothing an installed
folder holds can enter it.

## Wave 1: read a Lens from JSON (done, `063c8b294e`)

`packages/lens`: add `lensFromJson(value: unknown): Result<Lens, ...>` composing
`defineTable` and `defineLens` over parsed JSON, returning their throws as a
typed error rather than propagating them. `packages/lens` is MIT and this adds
no dependency, so `check:licenses` stays at 12.

Tests: a round trip from `defineLens` through `JSON.stringify` and back is the
same Lens; a field outside the `field.*` vocabulary is refused; a table name that
is not a bare SQL identifier is refused; a single-label namespace is refused.

## Wave 2: the id becomes the namespace, and a check disappears

`APP_ID_PATTERN` in `packages/constants/src/app-data.ts` widens from
`/^[a-z0-9-]+$/` to admit `.`, so a namespace is a valid app id. Bare ids stay
legal, which is what leaves `local-mail` and `local-books` untouched.

`deriveAppCatalog` stops taking the id from the directory name and takes it from
`<dir>/lens.json`: read, `lensFromJsonText`, and the namespace *is* the id. Three
refusals, each making the folder not a member, the same disposition a missing
`index.html` gets:

- no `lens.json`
- it does not parse as a Lens
- its namespace duplicates one already admitted in this generation

The last is new, and it is new because folder names stopped meaning anything: the
filesystem used to refuse two directories with one name and now refuses nothing.

**Deleted in this wave, because it became unreachable rather than tiresome:**
`RESERVED_APP_IDS`, the `reservedIds` parameter on `loadActiveAppCatalog`,
`deriveAppCatalog`, and `promoteAppCatalogCandidate`, both call sites that supply
it (`main.ts`, `scripts/publish-app-catalog.ts`), the `isAppId` check on the
candidate's directory name, and the AGENTS.md hazard note about assembling half
the reserved list at one call site. Every reserved id is bare and every installed
id has a dot, so the sets are disjoint by grammar.

**Also deleted:** `documentTitle`. Title resolution becomes the Lens's title or
the namespace. Compiled applications are unaffected: their titles come from
`SURFACE_ROUTES`, never from that function.

`promoteAppCatalogCandidate` copies into `<generation>/<namespace>/` rather than
preserving the candidate's directory name.

Tests: a valid declaration becomes a member whose id is its namespace, with its
title; two candidates declaring one namespace admit neither; a folder with no
`lens.json` is not a member; malformed JSON is not a member; a bare id is still
valid so composed apps keep their directories.

## Wave 2b: Rust stops assuming a bare id

`parse_application_id` (`lib.rs:594`) accepts `[a-z0-9-]` today and must admit
`.`. `app_window_label` maps `.` to `_`, which is a bijection because a namespace
cannot contain `_`, `:`, `/`, or uppercase. The `app-*` capability glob is
unaffected.

Test: two namespaces never produce one label, and a label round trips to exactly
one id.

## Wave 3: the host composes the catalog's Lenses

`main.ts` stops passing three literals and passes the compiled list plus the
selected generation's, to all three consumers at once: `startFolderRenderer`,
`startFolderProjector`, and `createHomeServer`'s `inspect`. The three must take
the same list or the folder and the Data pane disagree about what exists.

## Wave 4: prove it end to end

Build `apps/vocab` and write `lens.json` beside its `index.html`, which is
`JSON.stringify(vocabLens)` from `apps/vocab/vocab.ts:132` with a title added.
Its namespace is already `so.epicenter.vocab`, so that is its id, its route, and
its directory, with nothing to change. Publish, restart.
Expect `so.epicenter.vocab` in the Data pane sidebar with its three tables, and
`~/Epicenter/so.epicenter.vocab/` holding markdown beside
`so.epicenter.vocab.sqlite3`.

`apps/epicenter/bench-oneshot.ts` (gitignored) already boots the real Home over a
seeded replica and takes `EPICENTER_CATALOG`, so this is checkable in a browser
without a GUI session.

## Open, and not blocking

Vocab's own build does not yet write to the host replica: it would need to import
`openDesktopEpicenter`. Nothing in the host stops it, so this is Vocab's change
and not the host's, and the waves above are provable with rows written by any
writer.
