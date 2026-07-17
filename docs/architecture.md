# Epicenter architecture

Epicenter is a local-first workspace platform. Apps define stable workspace
families, clients keep complete local data, and a hosted or self-hosted star
keeps devices synchronized while they sleep.

This page is the five-minute map. Durable decisions live in
[`docs/adr`](adr/README.md). Shared vocabulary lives in
[`docs/CONTEXT.md`](CONTEXT.md). Package-owned current behavior belongs in
package READMEs and code.

## The stack

Apps compose middleware and core packages. Dependencies point downward; product
policy stays in the app that can name it.

```text
+----------------------------------------------------------------------------+
| APPS                                                                       |
|                                                                            |
| whispering   honeycrisp   epicenter   tab-manager   api   self-host        |
| landing      local-books  local-mail  opensidian    todos                  |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| MIDDLEWARE                                                                 |
|                                                                            |
| @epicenter/svelte      @epicenter/filesystem                               |
| @epicenter/skills      app-owned runtime composition per environment       |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| CORE                                                                       |
|                                                                            |
| @epicenter/workspace   @epicenter/row-sync   @epicenter/sync               |
| @epicenter/field       @epicenter/constants  @epicenter/ui                 |
+----------------------------------------------------------------------------+
```

`@epicenter/workspace` owns the app-facing data contract and runtime handles.
`@epicenter/field` supplies the release-local projection vocabulary.
`@epicenter/row-sync` owns the portable row-plane protocol: row intent folding,
exact retry, outcome paging, compaction, and baseline acquisition. Row-owned
Yjs document updates travel inside row intents and composite outcomes.

## Workspace definitions are app contracts

A workspace definition is pure. It names release-local table and KV lenses
without opening storage or a network connection. Every ordinary row owns one
optional Yjs document; document roots remain application-owned.

```text
defineWorkspace({ id, tables, kv })
        |
        | pure app contract
        v
runtime.open(definition)             Browser, Bun, desktop, or hosted runtime
```

Definitions are not storage schemas. A new release may change its lens
immediately. Nonconforming rows remain stored and visible to repair code.

Runtime openers supply the resources that cannot travel with the definition:
browser storage, desktop storage, row synchronization, materializers, auth, and
platform APIs. App-facing code should enter through the workspace definition
instead of rebuilding addresses or storage topology itself.

## The row plane is the ordered durable core

Workspace tables, workspace KV, and row-owned document updates all reduce to
row intents before they cross the synchronization boundary.

```text
workspace runtime
  create/update/delete rows, kv, row documents
        |
        v
row-sync protocol
  RowIntent, sealed rounds, tokens, outcomes
        |
        v
workspace authority
  SQLite-backed fold, receipts, paging, compaction, baseline scan
```

The workspace authority is schema-blind. It orders semantically valid row
intents and folds them into deterministic outcomes. It does not rename fields,
apply defaults, heal application data, or synchronize a device SQLite file as
the wire format.

Each replica tracks:

```text
acceptedRound  authored work the authority accepted from this replica
checkpoint     global authority outcomes this replica installed
requestDigest  exact retry identity for the accepted round
```

Those values intentionally stay separate. `acceptedRound` and `requestDigest`
support exact retry of authored work. `checkpoint` supports paging through
everyone else's confirmed outcomes.

For protocol details and executable coverage, read
[`packages/row-sync/README.md`](../packages/row-sync/README.md) and
[`packages/row-sync/src/protocol.test.ts`](../packages/row-sync/src/protocol.test.ts).

## Documents are merge-sensitive row content

Documents remain the right representation for merge-sensitive content. Every
ordinary row owns optional Yjs state under the same identity and lifecycle as
its fields. The workspace API exposes that state through the row's singular
document handle.

Opening a document hydrates its confirmed, sealed, and open components from
local SQLite. Edits become durable document-bearing row intents, and the
authority merges their Yjs updates into composite row outcomes. Releasing the
last handle unloads live state without deleting it; deleting the row revokes
its handles and removes its document state.

Yjs supplies merge semantics inside a row. It is not a second public address,
sync protocol, room, or lifecycle.

## Lens evolution never migrates user data implicitly

Definitions are views over durable JSON. A release may add a required field,
remove a field, or change validation. Rows that no longer conform remain
preserved as invalid data. The runtime does not copy a database, execute an
upcaster, add fallback keys, or reinterpret old writes.

When product semantics require conversion, the application owns a normal,
explicit repair loop. It may recognize an old shape, compute the new value, and
issue bounded typed patches. Mixed releases may disagree until the repair
converges; that is honest application behavior rather than a platform migration
protocol.

```text
durable JSON stays unchanged
        |
        +-- old release lens -> one interpretation
        `-- new release lens -> valid rows plus explicit invalid rows
```

## The star owns availability, not application meaning

A star is the runnable deployment that holds a person's synchronized data. The
hosted Cloud app and the self-hosted instance use the same shared server library
but resolve principals differently.

The workspace authority backend owns ordering, current rows and row-document
update logs, receipts, compaction, and baseline acquisition. Application
releases own field validation, document roots, and explicit repair code. Blob
storage holds large binaries by reference.

This separation keeps the privacy question concrete. Epicenter can run the
star, or the user can run it. In either topology, apps keep their schema meaning
and product policy at the client boundary.

## Current transition

The selected direction is workspace authority plus row-owned document updates. Some
workspace implementation code still lives under
`packages/workspace/src/sqlite`, and older public workspace paths still contain
root-Y.Doc-era concepts. Treat those as migration surfaces, not ownership
boundaries.

During the transition, use accepted ADRs, package READMEs, executable tests, and
code as current implementation truth. Use this architecture page to judge
conversions, delete legacy branches, and prevent root-Y.Doc topology from
leaking back into the selected vocabulary.
