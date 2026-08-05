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

## Wave 1: read a Lens from JSON

`packages/lens`: add `lensFromJson(value: unknown): Result<Lens, ...>` composing
`defineTable` and `defineLens` over parsed JSON, returning their throws as a
typed error rather than propagating them. `packages/lens` is MIT and this adds
no dependency, so `check:licenses` stays at 12.

Tests: a round trip from `defineLens` through `JSON.stringify` and back is the
same Lens; a field outside the `field.*` vocabulary is refused; a table name that
is not a bare SQL identifier is refused; a single-label namespace is refused.

## Wave 2: admission reads `epicenter.json`

`deriveAppCatalog` reads `<id>/epicenter.json` when present, taking an optional
`title` and an optional `lens`. `CatalogApp` gains `lens`. Three refusals, each
making the folder not a member, the same disposition a missing `index.html` gets:

- the file exists and is not valid JSON
- `lens` is present and does not parse as a Lens
- `lens` is present and its namespace's final label is not the app id

A folder with no declaration is admitted exactly as today and owns no namespace.

**`documentTitle` is deleted in this wave.** Title resolution becomes the
declared title or the app id, so the `<title>` regular expression and its
fallback chain go with it. Compiled applications are unaffected: their titles
come from `SURFACE_ROUTES`, never from that function.

Tests: a valid declaration becomes a member carrying its title and Lens; a
mismatched final label is not a member; malformed JSON is not a member; a folder
with no declaration is a member titled by its id.

## Wave 3: the host composes the catalog's Lenses

`main.ts` stops passing three literals and passes the compiled list plus the
selected generation's, to all three consumers at once: `startFolderRenderer`,
`startFolderProjector`, and `createHomeServer`'s `inspect`. The three must take
the same list or the folder and the Data pane disagree about what exists.

## Wave 4: prove it end to end

Build `apps/vocab`, write its `epicenter.json` (title `Vocab`, namespace
`so.epicenter.vocab`, whose final label matches the app id and whose Lens is
`vocabLens` from `apps/vocab/vocab.ts:132`), publish, restart.
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
