# 0332. Sign-in migration child-doc guids are derived from the schema

- **Status:** Accepted
- **Date:** 2026-07-02
- **Renumbered from 0092 (2026-09-01).** Two branches each kept 0092 as a provisional number and both merged, so `ADR-0092` cited two decisions. The more-cited record keeps the integer and this one took the next free number. Every `ADR-0092` citation elsewhere in the tree means the record that kept it.

## Context

The sign-in migration kit (`@epicenter/app-shell/sign-in-migration`) moves a
device's bare local doc into the owner doc on the first signed-in boot
(ADR-0088). Per-row child docs (note bodies, chat transcripts) must ride
along, so the kit took an app-supplied `childDocs.guids: (tables) => string[]`
reader, and the `workspace-app-composition` skill carried a MUST rule: every
table with a `.docs(...)` declaration must appear in the reader, or Add
strands the child content in a bare database after the root copy clears. An
audit of all five apps (honeycrisp, vocab, opensidian, tab-manager,
whispering) found every hand-written reader encodes exactly one rule, "all
declared child docs of every table passed to `openLocalSource`": zero app
judgment, five hand transcriptions of a derivable fact, and a
silent-data-loss failure mode enforced only by documentation. The schema
already knows everything needed: the unconnected root's tables carry the
guid-only `.docs.<field>.guid(rowId)` derivers that `createWorkspace` builds
from each table's child-doc declarations.

## Decision

The migration kit derives the child-doc guid set itself: for every table in
the opened local source, for every entry in the table's `.docs` namespace,
for every scanned row, `field.guid(row.id)`. The `childDocs` option is
deleted, not made optional. Excluding data from migration happens in one
place only, the table subset an app's `openLocalSource` returns, which
excludes a table's rows and its child docs together. There is no per-field
exclusion: copying a row while stranding its declared body is the exact loss
the kit exists to prevent, and no app wants it.

## Consequences

Five hand-written `guids` readers and the skill's MUST paragraph are deleted;
a new app cannot forget a child-doc table because there is nothing left to
write. The kit's table constraint widens to carry the guid-only `.docs`
namespace, which every `create()` root already satisfies. A workspace with no
declared child docs (whispering) derives an empty set and skips the child
phases, identical to omitting the old option. If a future schema declares a
child doc that must not migrate (say, a device-local cache body), that is a
schema design smell first; an explicit exclusion option may be reintroduced
then, as a new decision that supersedes this one.
