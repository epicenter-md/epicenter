# Fold, Never Refuse: The Workspace Data Plane

**Date**: 2026-07-16
**Status**: Draft
**Owner**: Braden
**Branch**: `codex/sqlite-sync-architecture`
**Companion**: [`20260716T161934-workspace-tables-kv-row-bodies.md`](20260716T161934-workspace-tables-kv-row-bodies.md) (public API contract; this memo settles the plane beneath it)

## Product Sentence (accepted)

One SQLite file per device owns rows, settings, and pending intent; one
schema-blind authority folds sealed rounds into a single order; lenses
interpret, never migrate; deletion is permanent; sync is transport, not
history.

## Accepted Refusals

Each entry states the refusal, the deletion prize, and the user loss. A moved
responsibility is listed as moved, not deleted.

| # | Refusal | Decision | Prize | Loss |
| --- | --- | --- | --- | --- |
| 1 | Remove KV `unset` | **Rejected** | One verb (and, only under per-key state, a tombstone family) | Reset-to-absence and future-default behavior; the absent/chosen/invalid distinction |
| 2 | No same-row-id recreation | **Accepted** | Row incarnation token, per-row lifetime metadata, old-lifetime body fencing state | Id-preserving restore and import; restore/undo becomes app-level soft delete; importers mint fresh ids and rewrite references |
| 3 | No cross-row/cross-unit atomic visibility | **Accepted** | Round-aligned paging, cross-unit transactional coupling | Apps needing observed-together invariants use one row, one KV value, or one body |
| 4 | No cached retry responses | **Accepted** | Stored batch JSON (up to 768 KiB/actor) and the six-field receipt | None; retry answers with regenerated current images, which is the same-key doctrine anyway |
| 5 | No authority rejection after local admission | **Accepted** | Quarantine table, dependent-intent partitioning, actor rotation, `requires_bootstrap` wipe-and-rebootstrap | Rejected-intent evidence; an over-cap concurrent patch or losing duplicate create evaporates like any same-key conflict loser (surfaced as a local diagnostic) |
| 6 | No per-key incremental KV state | **Accepted** | KV tombstones, per-key sequences, a second deletion-retention subsystem | Whole-map transfer per KV change (1.7 KiB measured, 64 KiB ceiling) |
| 7 | No public multi-key KV transaction or deep patch | **Accepted** | Deep-patch language, multi-key conflict doctrine | Two keys can be observed mid-change; keys that must move together become one object value |
| 8 | No partial replication | **Accepted** | Subscription language, per-device visibility state | Workspace ceiling = weakest device (already the ADR-0118 gate) |
| 9 | No device clocks, per-cell timestamps, permanent history | **Accepted** | HLC/skew failure modes, per-cell metadata, audit subsystem | Chronology; undo/audit are explicit application tables |

Refusal 2 is structural, not policed: the authority keeps no used-identity
registry (ADR-0119 refuses one, and compaction forgets deleted ids). The
public `create` allocates UUIDs and accepts no caller-supplied id anywhere,
so recreation is unreachable rather than forbidden.

## The Fold Rules (replaces post-hoc refusal)

Server acceptance order already resolves same-key conflicts (ADR-0121). The
same doctrine now resolves capacity and identity, as fold rules inside
`foldRow`, so that every admitted round is accepted:

1. **Capacity**: a command whose folded row would exceed the row cap folds to
   a deterministic no-op. The command is still accepted and ordered.
2. **Identity**: `createRow` on a live row folds to a no-op; first create
   wins. Reachable only via cloned forks and duplicate submissions, since ids
   are random.

Honesty notes:

- No compositionally closed local bound exists for schema-blind patch
  composition (byte caps and key-count caps share the same hole), so the cap
  must be enforced at fold time; the only choice is refuse-and-quarantine
  versus fold-to-no-op. Fold-to-no-op was chosen.
- The client mirrors both rules in its optimistic replay so visible state
  approximates future accepted state. This is a moved responsibility, not a
  deletion.
- The client should surface "this pending edit did not apply" as a local
  diagnostic. Optional, app-visible, no authority machinery.
- Today's replica replay (`replayOutbox` -> `applyCommand`) folds pending
  commands over freshly installed state without re-checking admissibility, so
  local state can already exceed the cap before any refusal arrives; the
  mirror rule closes an existing hole rather than opening one.

## Synchronization Exchange (accepted: corrected `sync()` verb)

```
sync({ token, sealedRound? }) -> { token', statePage, hasMore }
```

- A pull is a sync with no round. A push acknowledgement is the first page of
  the same state stream. Snapshot-required is a response variant. Dumb
  snapshot chunk fetches stay a separate request.
- A sealed round is `(replicaId, round, requestDigest)`. Commands carry no
  per-command sequence; order within a round is array order; the authority
  high-water per replica is one round number.
- The authority folds a new round exactly once in one transaction, then
  serves ordered current-state pages from the caller's checkpoint.
- Retry of an accepted round: digest matches, nothing refolds, pages are
  regenerated from current state. Digest mismatch on the same round is the
  **only terminal verdict** (cloned fork). Fork recovery is
  safe-by-construction: fresh replica identity, resubmit pending intent,
  everything folds (duplicate creates no-op, patches reapply their values).
- **Touched state does not always fit one response** (worst case ~64 rows x
  508 KiB composed images against an 8 MiB page cap), so the exchange pages.
  The sealed round is removed only when the exchange completes (checkpoint
  passes the round's last sequence). Until then the client replays the sealed
  round over each installed page so its own writes never visibly regress: one
  "round accepted, awaiting checkpoint" bit replaces today's per-command
  `accepted_server_sequence` stamps. Typical acks fit one page.
- **Rounds are accepted before stale-client bootstrap, always.** Under fold
  rules a below-floor client's round folds deterministically against current
  state; staleness has no depth limit. Round first, snapshot second.
- The opaque token packages `(replicaId, acceptedRound, checkpoint)`. This is
  packaging that prevents independent drift, not a state deletion; both sides
  still hold the facts.

### State machine accounting

| Machinery | Fate | Enabled by |
| --- | --- | --- |
| Quarantine, dependent partitioning, actor rotation, rebootstrap wipe | Deleted | Refusal 5 |
| Stored `batch_json` + receipt per actor | Deleted; authority keeps `(replicaId, acceptedRound, requestDigest)` | Refusal 4 |
| Per-command `actorSequence` + contiguity checks | Deleted; one round number | Round framing |
| Per-command accepted-awaiting-pull stamps | Reduced to one per-round bit | Ack carries state |
| Row tombstones, compaction floor, snapshot manifest/chunks | Survive unchanged | Deletion notification is transport state regardless |
| Snapshot staging tables (client) | Survive | Interrupted-install resume |

Server-heavy alternatives (per-replica server diffs, server shadow state) all
grow authority state beyond the three-value replica record to save client
bytes the ordered stream plus snapshot floor already bounds. Refused.

## Failure Matrix

| Scenario | Outcome under the accepted protocol |
| --- | --- |
| Request lost before authority commit | Retry; digest unknown; folds as a new round. |
| Authority commits, response lost, another replica overwrites the key, original retries | Digest matches; no refold; regenerated pages show the overwrite; round removed at completion. Ordered-then-overwritten is the same-key doctrine. |
| Cloned replica: two forks submit different payloads for one round | First accepted; second gets the fork verdict; new replica identity + resubmit + pull converges. (Today's code throws forever on `actor-fork`.) |
| Client crashes during state installation | Each page installs in one SQLite transaction with the token; reopen resumes from the last completed page; the sealed round persists until completion and is replayed over pages. |
| Catch-up spans pages while touched rows change again | A re-changed row reappears at its new sequence in a later page; the `hasMore` loop runs to head; monotone-entry checks hold. |
| Checkpoint below the compaction floor | Snapshot-required variant; the round (if any) was already accepted; staged chunk install; pending replay after. |
| Snapshot installation interrupted | Staging resumes by chunk index; final install is one transaction. |
| Locally valid command becomes invalid only after concurrent composition | Capacity fold-to-no-op; deterministic; mirrored in local replay; local diagnostic. |
| Row deletion races a late body update | Row absent at the authority means dead forever; body state purged; late updates permanently rejected. |
| Import or move meets an old row identity | Impossible by construction: importers mint fresh ids and rewrite references; the public create has no id parameter. |

## Row-Body Lifetime Model (accepted)

A body is row-owned with no public identity. It opens and edits locally while
offline; synchronization parks until the row's create is accepted; deleting
the row purges authoritative body state and permanently rejects late updates,
because absence now means death. No incarnation token, no lifetime integer,
no old-lifetime fencing state. Open mechanisms for the implementation wave:
browser edit-durability acknowledgement and the row/body authority topology
prototype (per the companion spec).

## KV Model (accepted semantics, two encodings funded)

Semantics: per-key `set`/`unset` commands (different keys compose; same key
follows server order; nested values replace atomically); aggregate state (one
bounded map image at the authority, on the wire, in snapshots; absence is a
missing key in the newest image; `unset` is therefore free). Declared keys
are a release-local lens; unknown and nonconforming bounded JSON survive
every path (ADR-0130).

Encoding candidates, both funded through the falsification plan; the winner
is the smallest permanent invariant set that passes, tie broken by counted
wire/storage surfaces:

1. **A2, reserved record address**: `kv.set` compiles to `patchRow` at
   `__epicenter_kv/workspace`. One fold exception (patch-on-absent folds from
   `{}` at this address), reserved-prefix admission rules
   (`createRow`/`deleteRow` inadmissible there), 64 KiB cap. Zero new wire,
   state, snapshot, or authority vocabulary. The prior killer objection
   (ensure-create quarantine race) died with refusal 5.
2. **First-class KV vocabulary**: `kvSet`/`kvUnset` commands, a KV state
   entry kind, dedicated authority storage and snapshot section. Wire matches
   the public model exactly; roughly 2-3x the code and four new permanent
   surfaces. (Recorded Codex dissent position.)

### Falsification plan

- Shared harness: two replicas + one authority over `bun:sqlite`; scripted
  traces for every proof-matrix row in the companion spec.
- Trace set per candidate: local write -> pending replay -> acceptance ->
  snapshot bootstrap -> compaction -> mixed-version (old `protocolMajor`
  refused at the envelope). Falsifier: any inter-replica divergence or
  fold-rule violation.
- Capacity interaction: two replicas patch disjoint KV keys past the 64 KiB
  cap; the later patch must fold to a no-op identically on authority and
  replica replay.
- Measurements: OPFS round-trip and snapshot delta at 1.7 KiB (Whispering's
  39 settings, measured) and at the 64 KiB ceiling. Falsifier for aggregate
  state: any real consumer that cannot fit the ceiling or whose write rate
  makes whole-map shipping measurably slow.

## Owners

| Plane | Owner | Holds |
| --- | --- | --- |
| Client | Canonical replica runtime | Records map, KV map image, outbox + one sealed round, token, optimistic replay with mirrored fold rules, body update logs, no-op diagnostics |
| Authority | Record authority | `server_sequence`, current rows + KV image, deletion tombstones + floor, snapshot manifest/chunks, per-replica `(replicaId, acceptedRound, requestDigest)`, all fold rules |
| Wire | record-sync protocol | `sync` exchange, snapshot chunk fetch, three commands (KV encoding pending prototype), state pages, opaque token |
| Durable data | Schema-blind JSON | Rows, KV map, body updates; blobs stay external content-addressed bytes; lenses are release-local and never migrate |

## ADR Disposition

| ADR | Disposition |
| --- | --- |
| ADR-0119 | **Supersede in part.** Three commands, schema-blind map, complete replicas, snapshot floor survive. Superseded: the quarantine/actor-rotation/rebootstrap paragraph (fold rules replace refusal), per-command actor sequences (round framing), and `createRow` "refuses a live duplicate" (first-create-wins no-op). One new Proposed ADR carries all three changes. |
| ADR-0121 | **Survives, strengthened.** Server order now also resolves capacity and identity; the new ADR relates, nothing in 0121 changes. |
| ADR-0122 | **Survives.** Portability law, private SQLite, TEMP views untouched. The checkpoint's "actor high-water marks" become replica/round marks; terminology rider in the protocol ADR. |
| ADR-0123 | Survives. |
| ADR-0130 | **Amend, then accept.** Restate the body lifetime as ids-never-recreate (the recreation sentence becomes vacuous); narrow the KV encoding question to the two funded candidates; everything else stands. ADR-0093/0124 supersession proceeds as written. |
| New ADR A (Proposed) | Fold-never-refuse + dead-forever ids + the `sync()` round exchange (this memo's protocol section). |
| New ADR B (Proposed, post-prototype) | KV encoding winner. |
| New ADR C (Proposed, post-prototype) | Row/body authority topology, per the companion spec's Wave 0. |

## Outstanding Verification

Two independent Codex audits were commissioned and are unretrieved
(`/codex:result task-mro6p6m0-in1roz`, state-machine derivation;
`/codex:result task-mro6pkm0-01ifl8`, no-refusal falsification). Reconcile
them against this memo; if either produces a counter-trace to the fold rules
or the paged exchange, refusal 5 and the protocol section reopen before any
implementation wave.

## Authorized Next Wave (not started)

Nothing below is authorized by this memo alone:

1. Reconcile the Codex audits.
2. Write New ADR A; amend ADR-0130.
3. Build the KV falsification harness; run both encodings; write New ADR B.
4. Row/body authority prototype; write New ADR C.
5. Then the companion spec's Waves 1-8.
