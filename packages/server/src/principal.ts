/**
 * Server-only derived identifiers built from a `PrincipalId`.
 *
 * `PrincipalId` itself lives in `@epicenter/identity` because it flows through
 * `/api/session`, the persisted auth cell, and every client (browser,
 * extension, CLI, daemon). What lives here are the durable strings only
 * a server cares about: Durable Object names, R2 object keys, and the
 * partition path segment they all share.
 *
 * Per-user and instance share the exact same path shape. The partition
 * segment is always `principals/<principalId>`. In the hosted topology the
 * principal may be a Better Auth user id; on an instance it is the pinned constant
 * `INSTANCE_PRINCIPAL_ID` (the literal `instance`). The path is honest either way:
 * every durable identifier the server writes is rooted at
 * `principals/<principalId>`.
 *
 * Every durable string follows the rule:
 *   `principals/<principalId>/<resource type>/<id>`
 *
 * One shape, one helper per resource type, no ternary.
 */

import type { BlobId } from '@epicenter/blobs';
import type { PrincipalId } from '@epicenter/identity';

/**
 * R2 object key template for an opaque-id blob, single form. The BlobId is
 * used verbatim: R2 is the index, with no separate database row. See
 * ADR-0089 (presigned S3 kernel) as amended by ADR-0148 (opaque BlobId).
 */
export type BlobR2Key = `principals/${string}/blobs/${string}`;

/** Common prefix for one partition's blobs, used by the S3 client's list enumeration. */
export type BlobPrincipalPrefix = `principals/${string}/blobs/`;

/**
 * Durable Object name template for one partition's store of one application.
 *
 * One Durable Object per `(principalId, namespace)` rather than per principal,
 * because ADR-0215 makes an application ONE document and the authority's log is
 * that document's: two applications sharing a log would interleave positions
 * neither could read past. The `principalId` segment is the partition, so a
 * client that names another application's namespace still lands inside its OWN
 * partition.
 *
 * The application is named by its Lens namespace, which is the same identifier
 * the replica derives its local storage from, so the two halves of one
 * application cannot come to disagree about which application they are.
 */
export type StoreAuthorityDoName = `principals/${string}/stores/${string}`;

/** Durable key of an opaque-id blob's R2 object. */
export function blobKey(principalId: PrincipalId, blobId: BlobId): BlobR2Key {
	return `principals/${principalId}/blobs/${blobId}`;
}

/** Prefix matching every blob this partition has stored. */
export function blobPrincipalPrefix(
	principalId: PrincipalId,
): BlobPrincipalPrefix {
	return `principals/${principalId}/blobs/`;
}

/** Durable name of one partition's store authority for one application. */
export function storeAuthorityName(
	principalId: PrincipalId,
	namespace: string,
): StoreAuthorityDoName {
	return `principals/${principalId}/stores/${namespace}`;
}
