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

import type { PrincipalId } from '@epicenter/identity';

/** Durable Object name template, single form. */
export type RoomDoName = `principals/${string}/rooms/${string}`;

/**
 * Durable Object name template for one principal's AttachHub (ADR-0115). One DO
 * per principal: every desktop host and every client of that principal route to
 * the same actor, which is the invariant the in-DO {@link createAttachRelay}
 * coordinator needs to see every socket. That one actor owns both the live
 * rendezvous sockets and the host directory a phone's `GET /attach/hosts` reads,
 * so liveness is joined against the live socket set with no cross-DO push. There
 * is no `hostId` segment: one hub holds every host of the principal, not one
 * pair. The `principalId` segment is the partition, so a client that guesses
 * another principal's `hostId` still lands in its OWN hub (holding none of the
 * target's hosts) and pairs with no host.
 */
export type AttachHubDoName = `principals/${string}/attach-hub`;

/**
 * R2 object key template for a content-addressed blob, single form. The id
 * segment is a sha256 hex digest, so the key IS the content address: R2 is
 * the index, with no separate database row. See
 * ADR-0089 (the blob store is a presigned-S3 kernel and the bucket is its only index).
 */
export type BlobR2Key = `principals/${string}/blobs/${string}`;

/** Common prefix for one partition's blobs, used by the S3 client's list enumeration. */
export type BlobPrincipalPrefix = `principals/${string}/blobs/`;

/** Durable name of a room's Cloudflare Durable Object. */
export function doName(principalId: PrincipalId, roomId: string): RoomDoName {
	return `principals/${principalId}/rooms/${roomId}`;
}

/** Durable name of one principal's AttachHub Cloudflare Durable Object. */
export function attachHubDoName(principalId: PrincipalId): AttachHubDoName {
	return `principals/${principalId}/attach-hub`;
}

/** Durable key of a content-addressed blob's R2 object (id = sha256 hex). */
export function blobKey(principalId: PrincipalId, sha256: string): BlobR2Key {
	return `principals/${principalId}/blobs/${sha256}`;
}

/** Prefix matching every blob this partition has stored. */
export function blobPrincipalPrefix(
	principalId: PrincipalId,
): BlobPrincipalPrefix {
	return `principals/${principalId}/blobs/`;
}
