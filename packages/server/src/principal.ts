/**
 * Server-only derived identifiers built from a `PrincipalId`.
 *
 * `PrincipalId` itself lives in `@epicenter/principal` because it flows through
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
import type { PrincipalId } from '@epicenter/principal';

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
 * One Durable Object per `(principalId, dataId)` rather than per principal,
 * because ADR-0215 makes an application ONE document and the authority's log is
 * that document's: two applications sharing a log would interleave positions
 * neither could read past. The `principalId` segment is the partition, so a
 * client that names another application's id still lands inside its OWN
 * partition.
 *
 * The application is named by its `dataId`, which is the same identifier the
 * replica derives its local storage from, so the two halves of one application
 * cannot come to disagree about which application they are.
 *
 * The resource segment is `data` rather than `stores` (ADR-0276). A store is the
 * runtime object a client holds; what is addressed here is one data definition,
 * the value of `defineData({ id })`. It is a sibling of `blobs` under the same
 * partition, which is the whole job `stores` was doing.
 *
 * The name carries the GENERATION (ADR-0276, ADR-0292), and that is what makes
 * the object an exact address rather than a mutable one: a generation is
 * created once and never mutated in place, so an object at this name holds one
 * history and a replica that reached it cannot be carrying another's bytes.
 * The document identity stamp existed to answer that question and is retired
 * with it.
 *
 * Nothing anywhere maps an old name to a new one: the name is derived on both
 * halves from values they already hold, so a rename strands data rather than
 * requiring a migration.
 */
export type StoreCollectionDoName = `principals/${string}/data/${string}`;
export type StoreAuthorityDoName =
	`${StoreCollectionDoName}/generations/${number}`;

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

/**
 * Durable name of one partition's generations ledger for one database.
 *
 * The bare name the authority used to hold. It holds numbers now: which
 * generations exist, which is what makes one addressable at all (ADR-0293).
 */
export function storeCollectionName(
	principalId: PrincipalId,
	dataId: string,
): StoreCollectionDoName {
	return `principals/${principalId}/data/${dataId}`;
}

/** Durable name of one partition's authority for one database generation. */
export function storeAuthorityName(
	principalId: PrincipalId,
	dataId: string,
	generation: number,
): StoreAuthorityDoName {
	return `principals/${principalId}/data/${dataId}/generations/${generation}`;
}
