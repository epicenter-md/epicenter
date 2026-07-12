# Handoff: implement records-schema succession

Continue in `/Users/braden/.codex/worktrees/6d9d/epicenter` from the active
spec, `specs/20260711T103822-server-authoritative-sqlite-sync.md`.

This handoff starts after the Wave 1 documentation and design-evidence collapse.
The records-migration API, records-migration runner, workspace-family authority,
successor candidate routes, staging runtime, and replacement Gate 3 are still
unimplemented. Current `@epicenter/record-sync` snapshot manifests are ordinary
sync-compaction artifacts, not successor candidates.

Preserve the dirty worktree. Inspect live diffs before editing. Do not restore
the discarded epoch, incarnation-transition, source-freeze, lease, device
roster, private-overlay, or server-executed-transform models.

## One sentence

A user-approved update rebuilds the current records database under a new
immutable records schema; a trusted application client prepares a complete
successor from canonical database A at head H, and the schema-blind authority
activates it only if A is still current and unchanged.

## User flow

```txt
application detects records-schema mismatch
  -> user opens important devices and waits for “Synced”
  -> user stops editing and approves
  -> client reads canonical A at head H
  -> client composes adjacent application transforms
  -> client builds and validates candidate B
  -> client uploads and seals B
  -> authority conditionally activates candidateId
```

The user owns which devices matter. The authority does not enumerate migration
devices, bind `nodeId` to `actorId`, collect drain acknowledgments, wait for
devices, or track migration participation.

Forgotten old local databases remain readable and logically exportable. Their
unsynchronized edits never rejoin automatically. Version one provides no
generic late reconciliation or in-product recovery import.

## Final records migration API

```ts
import { recordsSchemaV1 } from './history/records-schema-v1';
import { recordsSchemaV2 } from './history/records-schema-v2';

export const notesMigrations = defineRecordsMigrations([
	defineRecordsMigration({
		from: recordsSchemaV1,
		to: recordsSchemaV2,

		transform: {
			notes: ({ cells }) => ({
				...cells,
				archivedAt: null,
			}),
		},

		discard: ['drafts'],
	}),

	defineRecordsMigration({
		from: recordsSchemaV2,
		to: notesWorkspace,

		transform: {
			notes: ({ cells }) => ({
				...cells,
				pinned: false,
			}),
		},
	}),
]);
```

Derived rules:

```txt
same name + canonically identical table descriptor
  -> copy automatically

same name + changed descriptor
  -> transform required

source-only table
  -> explicit discard required

target-only table
  -> begins empty

transform returns null
  -> omit that source row

runtime preserves source row id
  -> transform may read id but cannot author a replacement
```

Settled API decisions:

- Use `recordsSchemaV1`, not `recordsV1`, `tablesV1`, `databaseV1`, or
  `workspaceV1`.
- Use `defineRecordsMigration({ from, to, transform, discard })`.
- Use `defineRecordsMigrations(steps)` with no redundant target field.
- Copy implicitly under canonical descriptor equality. There is no authored
  `'copy'` token.
- Use `discard`, not `'drop'`.
- There is no `to()` helper.
- Keep `return null` for row-level omission.
- Keep adjacent linear composition.
- Keep same-table, same-row-id, zero-or-one-output restriction.
- Refuse table routing, renames, splits, merges, aggregation, and id changes.
- Describe complex remodeling only as a separate app-owned successor build or
  logical export/import boundary. Do not design that escape hatch in this wave.

“Records” is valid in migration and compatibility vocabulary even though
everyday CRUD uses tables and rows. A records schema covers synchronized tables
and fields only. KV, child documents, indexes, physical SQLite layout, and
workspace identity are excluded. V1/V2 names are source-code history labels;
`recordsSchemaHash` is authoritative compatibility identity.

The scoped API name is deliberate. The workspace package contains physical
storage evolution and child-document formats too; generic
`defineMigration`/`defineMigrations` names would imply a universal system.

Records succession never opens child documents. Per-document format conversion
may explicitly read one old format-addressed room and initialize one new room,
while retaining the old bytes. Moving data between records and documents is an
explicit app-owned authority transfer that chooses one final authoritative
plane. Neither operation gets a generic registry, workspace-wide document scan,
cross-plane transaction, permanent dual write, rollback, reconciliation, or
server-executed application conversion in version one. Source bytes remain
retained until separate explicit cleanup, but stop being authoritative after
cutover.

## Source validation

The records-migration client validates every canonical source row against the
historical source descriptor before invoking a typed transform. Any
nonconforming or quarantined source row blocks the whole succession. It is never
silently discarded, and `discard` or `return null` never acts as an implicit
repair policy.

The old records database remains unchanged and available for diagnosis and
logical export. The UI may report counts and row identities, but this work does
not design a repair system. Every emitted row is validated against the target
descriptor before upload.

## Authority serialization

Every ordinary write transaction must atomically:

```txt
require family.currentDatabaseId == request.databaseId
require the selected database is writable
fold the mutation
advance database head
commit
```

This serializes with activation:

```txt
write first
  -> A.head advances
  -> activation is stale

activation first
  -> A becomes non-current
  -> old-database write is rejected
```

Admission checks outside this transaction are not sufficient.

## Candidate protocol

Activation accepts only `candidateId`. The authority derives source database A,
source head H, target records-schema hash, and successor binding from the sealed
server-owned manifest and revalidates them inside the activation transaction.

Staging is a generic immutable logical-baseline upload:

```txt
candidate id
source database id
source head
target records-schema hash
immutable manifest digest
ordered chunk identities/content digests
row and byte counts
expiry
state: open | sealed
```

The manifest digest is SHA-256 over UTF-8 canonical JSON for the immutable
manifest body, excluding the digest field. The protocol fixes the manifest
fields and canonical order; chunks sort by index. Reject duplicate chunk
indexes and duplicate `(table, rowId)` identities across the candidate.

Exact idempotency:

```txt
same candidate id + identical manifest -> replay
same candidate id + different manifest -> conflict
same chunk index + identical bytes -> replay
same chunk index + different bytes -> conflict
reseal sealed candidate -> success
retry committed activation -> already-activated
genuinely stale candidate -> change nothing
```

Specify bounded candidate, chunk, row, byte, and lifetime quotas. The authority
owns cleanup. Expiry, sealing, activation, and cleanup serialize against
candidate and family state. Cleanup cannot delete a candidate that wins
activation; activation cannot revive an expired candidate; an activation
receipt survives cleanup of staged bytes.

The authority verifies transport completeness, integrity, and generic wire
limits. The trusted application client validates application-schema semantics.
Transform purity and determinism are guidance, not enforceable runtime
invariants; arbitrary TypeScript is not sandboxed.

## Wave 2 implementation boundary

Build and prove:

1. The adjacent records-migration types and load-time descriptor/chain
   validation.
2. A bounded-memory trusted-client runner with source and output validation.
3. Workspace-family current-database state and transactional ordinary-write
   admission.
4. Immutable candidate storage, upload, sealing, quotas, expiry, cleanup, and
   activation receipts.
5. `activate(candidateId)` with manifest-derived binding and atomic selection.
6. Replacement Gate 3 traces for both write/activation orders, concurrent
   candidates, every replay/conflict case, source-row blockers, and cleanup
   races.

Do not build:

- source freeze/unfreeze;
- transition or executor leases;
- device or actor migration rosters;
- drain acknowledgments or participant exclusion;
- private-overlay import or late reconciliation;
- server-executed transforms or a transform sandbox;
- table routing, rename, split, merge, aggregation, or id-remap vocabulary;
- a generic repair or recovery-import product.

## Verification

Run targeted type tests and protocol tests for the implemented slice, then:

```bash
bun run check:docs
bun run check:doc-paths
bun run check:doc-hygiene
bun run check:licenses
git diff --check
```

Use the repository's actual script names if these differ. Preserve and report
pre-existing failures separately. Perform the required post-implementation
review and a fresh-context adversarial pass before staging or handoff.
