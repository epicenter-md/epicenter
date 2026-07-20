# 0179. Owner-data routes are ID-free and specific to each synchronization plane

- **Status:** Proposed
- **Date:** 2026-07-19
- **Amends:** [ADR-0067](0067-auth-owns-the-session-endpoint-the-data-client-is-owner-scoped.md) by removing owner IDs from the data-client route surface.
- **Relates:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md), [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md), [ADR-0164](0164-accepted-membership-gates-immutable-s3-blobs.md), and [ADR-0175](0175-one-epicenter-durable-object-owns-one-principals-accepted-state.md)

## Context

Authentication already selects one principal and ADR-0160 fixes one Epicenter
per principal. Workspace or Epicenter path IDs repeat that ownership decision.
A broad `/api/sync` family would also imply that scalar settlement covers row
documents and blobs, despite their deliberately independent lifecycles.

## Decision

The shared hosted and self-hosted owner-data API uses these route families:

```txt
POST   /api/rows/push
POST   /api/rows/pull
POST   /api/rows/acquire
WS     /api/tables/:tableKey/rows/:rowId/document
POST   /api/blobs
POST   /api/blobs/:blobId/confirm
GET    /api/blobs/:blobId
DELETE /api/blobs/:blobId
```

Authentication resolves the selected owner before route handling. No account,
principal, Epicenter, or workspace ID appears in these paths.

`push`, `pull`, and `acquire` name the scalar row-replica protocol. Documents
use their row address and WebSocket lifecycle. Blob upload remains one SDK
operation implemented by a grant request, direct create-only S3 PUT, and
confirmation request. The routes expose no upload-session resource because
`BlobId` already identifies the bounded grant and v1 refuses multipart.

Hosted account, OAuth, billing, dashboard, and OpenAI-compatible inference
routes remain separate deployment surfaces. Auth continues to own
`GET /api/session`; it is discovery for the resolved principal and deployment,
not an Epicenter data operation. Portable artifact operations are not assigned
HTTP paths until their large-transfer and staging protocol is proved.

## Consequences

- Removing Workspace ID does not replace it with another redundant owner ID.
- Scalar settlement cannot be mistaken for document or blob settlement.
- The application-facing blob API may stay `upload`, `download`, and `purge`
  while the transport performs confirmation internally.
- Artifact semantics can stabilize without speculatively freezing hosted job
  endpoints.

## Considered alternatives

- **Use `/api/sync/*`.** Rejected because only scalar rows use the push, pull,
  acquire, and settlement protocol.
- **Prefix every route with `/api/epicenter`.** Rejected because the origin,
  authentication, and one-owner contract already provide that context.
- **Collapse blob grant and confirmation into one request.** Rejected because
  the direct S3 transfer happens between those two authority decisions.
