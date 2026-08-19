# 0248. Local Mail overlays intent in memory, and hands SQL only the ids it filters by

- **Status:** Accepted
- **Date:** 2026-08-18
- **Relates:** [ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md) (its decision is untouched: the durable write is still a per-message label assertion in a sibling database; this record decides only how a reader combines the two files), [ADR-0188](0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (clause 5 is why syncing intent was refused), [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md) (the replica / provider-copy distinction that decides why these two files cannot merge)

## Context

Every Local Mail read has to show Gmail's facts with this device's undelivered
assertions applied. The mirror connection did that by attaching `intent.db`
read-only and defining an `effective_labels` view that joined across the two
databases.

The join was there for one reason, and it is a real one. Filtering, ordering
and `LIMIT`/`OFFSET` all have to see the overlay, because an overlay applied
after paging can only ever *remove* rows from a page. It can never add the
message the user just moved INTO the label being viewed, which does not carry
that label in the mirror at all. A page computed on Gmail's facts and then
decorated would silently lose that message forever.

What it cost was disproportionate: a cross-database `ATTACH`, a URI-escaped
read-only filename, a temp view redefined on every open with a `create` and a
no-`create` arm, and a dependency on `SQLITE_OPEN_URI`. That last one is the
sharpest, because bun compiles URI parsing into its macOS build and not its
Linux one, so the class of mistake it guards against fails on a user's machine
and never on the developer's.

The pressure that resolved it is that the intent set is **tiny by
construction**. ADR-0198 made it a partial map holding an opinion only about
pairs the user actually touched, and `retire` empties a row as soon as Gmail
confirms it. It is not a table that grows with the mailbox. It is a handful of
ids describing work in flight.

## Decision

**A reader carries the overlay as data. SQL receives only the message ids it
must filter by, as bound parameters, and never a second database.**

The division of labour is fixed and load-bearing:

| Question | Who answers | How |
| --- | --- | --- |
| WHICH rows are on this page | SQL | `addedTo(labelId)` and `removedFrom(labelId)` go in as bound JSON arrays |
| WHAT each returned row says | TypeScript | `effectiveLabels(messageId, mirrored)` decorates it |

`overlayOf(intents)` in `overlay.ts` is the whole of the combination, and it
holds no database. `readPendingIntents` feeds it on `readPendingSummary`'s
terms: an account with no durable store has no local opinions, and asking must
never conjure a file.

The overlay is a **required** parameter on `listMessages` and
`getMessageDetail`. A default would let a caller who forgot it silently serve
Gmail's raw facts, putting archived messages back in the inbox with no error.
That has to be a type error rather than a bug someone notices in the product.

The ad-hoc SQL surface keeps `effective_labels`, because `local-mail query` and
the MCP `query` tool exist so an agent can write SQL against what the app
shows, and the tool's own description names the view. It is defined over a TEMP
table holding a copy of the overlay. A read-only handle may write there:
the temp schema is a separate, writable database even when the main one refuses
writes.

## Consequences

- `ATTACH DATABASE`, `readOnlyAttachUri`, `attachIntent`, and the
  `effective_labels` join inside the read models are deleted, and with them
  `SQLITE_OPEN_URI` in this app. The two files no longer meet inside SQLite.
- Opening the mirror no longer creates `intent.db`. It used to, only so the view
  had something to attach. A durable file now appears when something records an
  act, which is the rule the read-only opener already followed. Two tests
  asserted that side effect and now state their own preconditions.
- The overlay is read per request rather than held. The set is small enough that
  caching it would be the expensive part, and a triage act between two page
  loads has to be visible on the second.
- **Do not re-introduce a join here.** A future reader will notice that
  `effective_labels` is defined for the ad-hoc surface and conclude the read
  models should use it too. The un-archive case above is why they must not: the
  view is a decoration over rows SQL already chose, and the read models need the
  overlay *under* the filter. This is the one trap in the design.
- `apps/local-books` still passes `SQLITE_OPEN_URI` in its own `db-file.ts` and
  attaches nothing either, so the flag is dead there too. Removing it is a
  separate change, deliberately not made here.

## Considered alternatives

- **Page first, overlay in TypeScript afterwards.** The obvious shape, and it is
  wrong for exactly one case: a message asserted INTO the label being viewed is
  not in the page SQL returned, and decoration cannot add it. Discovering that
  case is what produced the shape above.
- **Move intent into `@epicenter/data` as a store.** Tempting, because intent is
  a hand-rolled replica: a monotonic sequence counter, `pending`/`retire` as an
  outbox with acknowledgement, `synchronous = FULL` because nothing can rebuild
  it. But that outbox already exists and points at **Gmail**, not at an Epicenter
  authority. A store would add a second, unused one, plus a Yjs document and an
  update log whose whole purpose is merging concurrent writes from several
  devices. There is one writer, on one device, forever, so there is nothing to
  merge.
- **Sync intent to the Epicenter authority, so triage follows the user across
  devices.** Refused, and not on taste. ADR-0188 clause 5 already states that no
  Epicenter server receives Gmail tokens, mail, or metadata, and message ids and
  label ids are metadata. Google's requirement is independent and stricter than
  a volume test: an app holding restricted-scope data that *has the ability to
  access data from or through a third-party server* owes a CASA security
  assessment, revalidated every twelve months. Local Mail uses `gmail.modify`, a
  restricted scope. Cross-device triage is therefore its own decision with its
  own record, gated on whether end-to-end encryption changes that answer, which
  is a question for Google's verification process rather than for this file.
- **Put the intent rows inside `mail.v<n>.db`.** This would delete the second
  file outright and with it every question above. It is refused because the two
  copies have different rebuild prices (ADR-0247): the mirror is replaced
  wholesale by a version bump, and intent is the only irreplaceable byte in the
  app. Sharing a file would make a `MIRROR_VERSION` bump silently delete triage
  Gmail has never heard about. ADR-0198 made that separation mechanical rather
  than intentional, and it stays that way.
