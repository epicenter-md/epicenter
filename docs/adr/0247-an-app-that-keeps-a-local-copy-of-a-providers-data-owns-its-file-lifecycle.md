# 0247. An app that keeps a local copy of a provider's data owns its file lifecycle

- **Status:** Accepted
- **Date:** 2026-08-18
- **Amends:** [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) at the clause placing the primitive in `@epicenter/sqlite/bun-mirror`. Its decision about how a version names a file, what opening does, who decides readiness, and what deletion may reach is unchanged and now lives in each app.
- **Relates:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) (the store and its projection stay in `@epicenter/data`; this record is about the copies that are not the store)

## Context

Epicenter keeps three kinds of local copy, and they were being described with
one shared vocabulary that fit none of them.

A **replica** can originate. Work is born there and exists nowhere else until it
syncs, which is why it needs a CRDT and why `_outbox` holds bytes the authority
does not have. A **projection** is rebuilt whole from the replica in the same
process, so it cannot be wrong: throw it away, rebuild it, and what comes out is
correct by construction. Local Mail's and Local Books' copies are neither. They
are maintained incrementally over a CDC API because a full rebuild costs hours
of a provider's metered quota, and an incrementally maintained copy **can be
silently wrong**: miss one change event and the file is short a message forever,
with nothing inside it saying so.

That last property is what a shared primitive could not name. `mirrorAt` had to
answer "what kind of thing is this?" for callers it had not met, and every
candidate word failed: "mirror" promises a fidelity a polled, deliberately lossy
copy does not have (ADR-0196 refuses attachment bytes outright), "cache" invites
exactly the deletion its own doc comment spends a paragraph warning against, and
"local copy" teaches nothing.

The primitive's shape was the tell. Its doc comment spent most of its length
refusing: no realm, no domain, no authority identifier, no filename override, no
path template, and no ownership of DDL, ingestion, cursors, readiness, locking,
permissions, or deletion timing. It had been sanded down until only filename
arithmetic was left, because everything interesting about the two copies
differs. Local Books' readiness is table existence; Local Mail's is a message
cursor. It also shared no code with the package it lived in: it never touched
`SqliteDatabase`, returned a raw `bun:sqlite` handle, and no file in the
repository imported both.

## Decision

An app that keeps a local copy of a provider's data owns that copy's file
lifecycle outright. There is no shared storage layer and no shared word for the
copy.

`@epicenter/sqlite` returns to being one thing: the contract for an embedded
SQLite handle (`run`, `all`, a synchronous `transaction`) plus one adapter per
runtime. `@epicenter/sqlite/bun-mirror` is deleted.

Local Mail and Local Books each own `src/db-file.ts`: the filename, the
directory listing, the two opening modes, and scoped deletion of lower versions.
Each names it in its own terms rather than a species: `DbFile`, `dbFileAt`,
`mailDbFile` / `booksDbFile`, `versions()`, `deleteOlderVersions()`. Every
promise ADR-0197 made about those operations holds unchanged, per app.

The vocabulary that survives is four words, each with a job no other word does:

| Word | What earns it |
| --- | --- |
| `replica` | it can originate; a rebuild has no price because there is no other copy |
| `projection` | rebuilt whole from the replica, so it cannot drift |
| `authority` | our server, the thing a replica syncs to |
| `provider` | Gmail, QuickBooks: whoever owns the data upstream |

`mirror`, `artifact`, `corpus`, `upstream`, and `external authority` stop being
terms of art. They stay as ordinary prose in ADR-0197, which is the right
altitude for them: the rule "bump the version when this build would store
something a previous build did not" is knowledge the two apps genuinely share
even though their code no longer does.

Extraction is reconsidered when a third app wants one, and not before, because a
third caller is the first evidence about what actually varies.

## Consequences

- The line count is roughly a wash: ~284 shared lines become ~250 in each app.
  This is not a deletion, and selling it as one would be dishonest. What it buys
  is that either app can change how it names, opens, and reclaims its files
  without negotiating with the other, and that neither has to answer "what kind
  of thing is this?" for a stranger.
- The naming question dissolves rather than being answered. Inside Local Mail
  there is no projection and no replica to be distinguished from, so the file
  needs a proper noun and not a species noun.
- Duplication is now the accepted cost, and the two copies are expected to
  diverge. A change made in one and not the other is correct by default, which
  is the opposite of the invariant a shared package would have enforced.
- Test coverage moved rather than shrank: `bun-mirror.test.ts`'s behavioral
  suites are ported into each app as `src/db-file.test.ts`. The name-grammar and
  version-grammar suites are gone with the generality they guarded, since the
  name is now a literal and the version a constant.
- No user data moves. Same filenames, same versions, same bytes. Nobody re-pulls
  a mailbox or a company.
- The relicensing ADR-0197 recorded is reversed in the safe direction: MIT code
  returns to AGPL apps. `bun run check:licenses` walks dependency edges only and
  could not see either move; this note is the record that both were intentional.
- `packages/sqlite`'s README was also factually stale: it claimed the browser
  runtime shares the substrate, when the browser store keeps its facts directly
  in IndexedDB and loads no SQLite at all. The browser adapter's one consumer is
  `apps/sync-lab`, and it exists because the projection takes its handle from
  the caller.
- Not done here: `MIRROR_VERSION`, `MIRROR_TABLES`, the `NoMirror` and
  `NotInMirror` error tags, and the `mirrorPath` / `mirrorBuilt` status fields
  keep their names. Those are app-internal or reported vocabulary, and renaming
  them touches READMEs, `AGENTS.md`, and the HTTP and MCP surfaces. It is a
  separate, visible decision.

## Considered alternatives

- **Keep the shared package and rename the concept.** This was the original
  question, and it has no answer: the word has to be a species noun, and every
  candidate either overstates fidelity, invites deletion, or teaches nothing.
- **Promote it to its own MIT package with `./bun` and room for `./browser`.**
  This generalizes on two callers who share only filename arithmetic. A browser
  copy of a Gmail mailbox in OPFS is genuinely desirable, and it will be the
  third caller that says what the shared shape is.
- **Fold the file naming into each app's `paths.ts`.** `paths.ts` owns per-tenant
  directories and deliberately does not name what is inside them. Splitting the
  filename from the opening modes would put one contract in two files.
