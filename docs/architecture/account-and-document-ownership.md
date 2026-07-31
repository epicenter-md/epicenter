# Account, workspace, and document scope

This is the current reference for the ownership boundaries around a workspace
and its row documents. Historical articles and ADRs may describe the deployed
principal-scoped room service; the Proposed destination is recorded here
separately from that transition state.

## Core rule

One account authority owns everything an authenticated principal stores: one
actor and one SQLite database containing every named workspace, its rows, KV,
and row documents. A row document has no independent global room identity.

```text
account authority (one per principal)
    `-- named workspace
        `-- table row
            `-- Yjs document
```

The complete route address is `(workspaceId, table, rowId)`:

- authentication resolves `principalId`;
- the authority address derives deterministically from that principal alone,
  so a workspace id is a name inside the requester's own partition
  (ADR-0092) and no request can address another principal's state;
- the route supplies `workspaceId`, `table`, and `rowId` inside that
  authority;
- the client never supplies a principal or arbitrary room id.

The row id is stable for one lifetime and is never reused by conforming
runtimes.

## Workspace is a data boundary, not an organization

Epicenter uses a workspace to group one application's queryable rows, KV, and
documents under one authority. It is not a billing account, team membership
container, or enterprise organization.

```text
content boundary       workspace authority and its rows
identity boundary      authenticated principal
billing boundary       account, with enterprise aggregation later
```

A principal can own several workspaces. Adding a workspace does not create an
organization-of-one, membership row, invitation system, or separate billing
customer.

## Proposed document addressing

Each open row document connects through its own route-bound Yjs 14 socket:

```text
/api/workspaces/:workspaceId/tables/:table/rows/:rowId/document
```

The route selects exactly one document. It does not use `ydoc.guid` as a public
room id, and the connection carries no other row document.

The same account authority serves scalar row synchronization and document
sockets. That lets one durable owner enforce the lifecycle invariant:

- rows that are not live admit no document bytes;
- live rows may append document updates;
- deletion removes the row, records a bounded deletion marker, and removes
  server document state in one transaction;
- conforming runtimes never re-mint a deleted row id, and only `create` can
  establish a row, so late updates cannot resurrect one.

Local scalar and document storage remain independent. Physical co-location in
native SQLite does not create a cross-plane snapshot promise.

## Authorization

Authorization is the partition rule itself: an authenticated principal is
always authorized for its own partition and can address nothing else. There is
no catalog, grant table, or per-request lookup. Reads create no logical
workspace, replica record, or user-data state; the first accepted write binds
a new `(workspace, replica)` pair under the account's storage allowance and
creates the workspace row, replica receipt, and data in one transaction.

Future sharing maps several accounts to one shared principal through
`ResolvePrincipal`, the seam ADR-0092 reserved. Every member then resolves the
same deterministic authority, so shared history cannot split, and no
per-workspace membership state exists until a real sharing product earns one.

## Tenancy and billing

Billing is per user account today. An enterprise organization may later group
accounts for administration and one invoice. It does not need to own the
workspaces or documents those accounts create.

This keeps three questions separate:

1. Who authenticated this request?
2. Which workspace and row does the request address?
3. Which account or organization pays for the service?

Answering one does not manufacture the others.

## Deployed legacy during transition

Some applications still use the older Yjs 13 room model:

```text
route     /api/rooms/:roomId
room      ydoc.guid
storage   principal-scoped room actor or file
```

In that deployed lane, authentication selects the principal and `ydoc.guid`
selects an arbitrary room beneath it. This remains operational until those
applications convert. It is not compatible with the Proposed route, Yjs major,
or persisted format, and the destination does not preserve a fallback reader.

## Related decisions

- ADR-0092 records that the authenticated principal is the partition; under
  ADR-0145 it is also the actor.
- Proposed ADR-0144 separates scalar and document client planes.
- Proposed ADR-0145 assigns both planes to one account authority with one
  route-bound socket per open row document.
- Proposed ADR-0146 selects Yjs 14-only providers and update logs.
