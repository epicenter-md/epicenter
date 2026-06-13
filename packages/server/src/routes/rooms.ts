/**
 * Rooms sub-app: one Cloudflare Durable Object per named Y.Doc.
 *
 * URL shape (uniform across modes): `/api/owners/:ownerId/rooms/:roomId`.
 * The deployment mounts auth and `requireOwnership` upstream;
 * `requireOwnership` resolves the partition from `(rule, user.id)`,
 * rejects URL `:ownerId` mismatches at the boundary, and populates
 * `c.var.ownerId` before this handler runs.
 *
 * The Durable Object name is the owner-partitioned identifier produced by
 * {@link doName}; nothing here interpolates strings inline. The DO itself
 * is owner-blind: every connection is identified by the
 * `(userId, deviceId)` pair stamped onto its WebSocket attachment.
 *
 * Each HTTP/WS access pushes a fire-and-forget upsert into
 * `c.var.afterResponse` so the platform-level `durableObjectInstance`
 * table tracks which owner's DO was touched and when. The row is keyed by
 * `do_name` and partitioned by `owner_id`; account-delete cleanup matches
 * `owner_id` (see auth `before(delete)` hook).
 */

import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import type { OwnerId } from '@epicenter/identity';
import { ROOM_ROUTE } from '@epicenter/sync';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { MAX_PAYLOAD_BYTES } from '../constants.js';
import * as schema from '../db/schema/index.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { requireBearerUser } from '../middleware/require-auth.js';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import { normalizeWebSocketAuth } from '../middleware/websocket-auth.js';
import { doName } from '../owner.js';
import type { OwnershipRule } from '../ownership.js';
import type { Env } from '../types.js';

type Db = NodePgDatabase<typeof schema>;

const log = createLogger('server/rooms');

const RoomsTelemetryError = defineErrors({
	DoInstanceUpsertFailed: ({
		cause,
		ownerId,
		doName,
	}: {
		cause: unknown;
		ownerId: OwnerId;
		doName: string;
	}) => ({
		message: 'durableObjectInstance telemetry upsert failed; row dropped',
		cause,
		ownerId,
		doName,
	}),
	DoInstanceDeleteFailed: ({
		cause,
		ownerId,
		doName,
	}: {
		cause: unknown;
		ownerId: OwnerId;
		doName: string;
	}) => ({
		message: 'durableObjectInstance telemetry delete failed; row orphaned',
		cause,
		ownerId,
		doName,
	}),
});

/**
 * Wrap a Uint8Array in a Response with a fresh ArrayBuffer copy. Yjs
 * encoders return views over a larger internal buffer; the copy isolates
 * exactly the bytes that should be sent.
 */
function binaryResponse(data: Uint8Array): Response {
	const body = new ArrayBuffer(data.byteLength);
	new Uint8Array(body).set(data);
	return new Response(body, {
		headers: { 'content-type': 'application/octet-stream' },
	});
}

/**
 * Fire-and-forget upsert into the platform DO instance table. Records that
 * the owner partition touched the DO and, when available, the post-access
 * storage size. Errors are logged and dropped: this is telemetry, not
 * billing authority. The failure is observable via the `server/rooms`
 * logger so silent telemetry loss surfaces in deployment logs.
 */
async function upsertDoInstance(
	db: Db,
	params: {
		ownerId: OwnerId;
		resourceName: string;
		doName: string;
		storageBytes?: number;
	},
): Promise<void> {
	const now = new Date();
	try {
		await db
			.insert(schema.durableObjectInstance)
			.values({
				ownerId: params.ownerId,
				resourceName: params.resourceName,
				doName: params.doName,
				storageBytes: params.storageBytes ?? null,
				lastAccessedAt: now,
				storageMeasuredAt: params.storageBytes != null ? now : null,
			})
			.onConflictDoUpdate({
				target: schema.durableObjectInstance.doName,
				set: {
					lastAccessedAt: now,
					...(params.storageBytes != null && {
						storageBytes: params.storageBytes,
						storageMeasuredAt: now,
					}),
				},
			});
	} catch (cause) {
		log.warn(
			RoomsTelemetryError.DoInstanceUpsertFailed({
				cause,
				ownerId: params.ownerId,
				doName: params.doName,
			}),
		);
	}
}

/**
 * Best-effort delete of a room's DO instance telemetry row after the room is
 * destroyed. Like {@link upsertDoInstance}, errors are logged and dropped: a
 * stale row over-reports storage but is not authority for anything.
 */
async function deleteDoInstance(
	db: Db,
	params: { ownerId: OwnerId; doName: string },
): Promise<void> {
	try {
		await db
			.delete(schema.durableObjectInstance)
			.where(eq(schema.durableObjectInstance.doName, params.doName));
	} catch (cause) {
		log.warn(
			RoomsTelemetryError.DoInstanceDeleteFailed({
				cause,
				ownerId: params.ownerId,
				doName: params.doName,
			}),
		);
	}
}

/**
 * Rooms sub-app. URL shape is uniform across modes; the resolved owner
 * partition arrives on `c.var.ownerId` via the deployment-mounted
 * `requireOwnership` middleware, so handlers stay mode-blind.
 */
const roomsApp = new Hono<Env>()
	.get(
		ROOM_ROUTE.pattern,
		describeRoute({
			description: 'Get room doc or upgrade to WebSocket',
			tags: ['rooms'],
		}),
		async (c) => {
			const roomId = c.req.param('roomId');
			const name = doName(c.var.ownerId, roomId);
			const room = c.var.rooms.get(name);

			if (isWebSocketUpgrade(c)) {
				// Validate deviceId presence at the route boundary so the DO
				// can trust the URL has it. deviceId is the dispatch address
				// `dispatch({ to })` resolves against; a missing one would
				// produce a presence-ghost connection (visible in presence
				// frames but unreachable by dispatch).
				if (!c.req.query('deviceId')) {
					const err = RequestGuardError.MissingDeviceId();
					return c.json(err, err.error.status);
				}

				// Stamp userId from auth, overwriting any client-supplied
				// value for safety. deviceId is the client's own identifier
				// so it rides through unchanged from c.req.url.
				const url = new URL(c.req.url);
				url.searchParams.set('userId', c.var.user.id);
				const stamped = new Request(url.toString(), c.req.raw);

				c.var.afterResponse.push(
					upsertDoInstance(c.var.db, {
						ownerId: c.var.ownerId,
						resourceName: roomId,
						doName: name,
					}),
				);
				return room.handleUpgrade(stamped);
			}

			const { data, storageBytes } = await room.getDoc();
			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					ownerId: c.var.ownerId,
					resourceName: roomId,
					doName: name,
					storageBytes,
				}),
			);
			return binaryResponse(data);
		},
	)
	.post(
		ROOM_ROUTE.pattern,
		describeRoute({
			description: 'Sync room doc',
			tags: ['rooms'],
		}),
		async (c) => {
			const roomId = c.req.param('roomId');
			const name = doName(c.var.ownerId, roomId);

			const body = new Uint8Array(await c.req.raw.arrayBuffer());
			if (body.byteLength > MAX_PAYLOAD_BYTES) {
				return new Response('Payload too large', { status: 413 });
			}

			const room = c.var.rooms.get(name);
			const { data: synced, error } = await room.sync(body);
			if (error) {
				return new Response('Malformed sync body', { status: 400 });
			}
			const { diff, storageBytes } = synced;

			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					ownerId: c.var.ownerId,
					resourceName: roomId,
					doName: name,
					storageBytes,
				}),
			);

			return diff ? binaryResponse(diff) : new Response(null, { status: 204 });
		},
	);

/**
 * Destructive room surface, mounted in personal mode only (see
 * {@link mountRoomsApp}).
 *
 * `DELETE` permanently destroys a room: it empties the persisted doc and
 * tombstones the Durable Object so every future sync/upgrade is refused. This
 * is owner-wide and irreversible, so it is gated to personal mode where the
 * owner partition is the user's own id (you can only destroy your own rooms).
 * In shared mode every user shares one partition, so exposing it would let any
 * member tombstone any shared room (including the root doc); that capability is
 * withheld until room deletion is scoped to declared child docs.
 */
const roomsDeleteApp = new Hono<Env>().delete(
	ROOM_ROUTE.pattern,
	describeRoute({
		description: 'Destroy a room and its persisted doc',
		tags: ['rooms'],
	}),
	async (c) => {
		const roomId = c.req.param('roomId');
		const name = doName(c.var.ownerId, roomId);

		await c.var.rooms.get(name).destroy();

		c.var.afterResponse.push(
			deleteDoInstance(c.var.db, { ownerId: c.var.ownerId, doName: name }),
		);

		return new Response(null, { status: 204 });
	},
);

/**
 * Mount the rooms surface on a deployment's server app.
 *
 * Bundles the full request pipeline for the only WebSocket surface:
 * transport normalization, auth, ownership, and the route mount, in one
 * call. Deployments call this once; they do not assemble the chain manually.
 *
 * Order matters. {@link normalizeWebSocketAuth} runs first so that on a
 * browser upgrade the ambient session cookie is dropped and the
 * `bearer.<token>` subprotocol is lifted into `Authorization` before
 * {@link requireBearerUser} (bearer-only: rooms is for external clients,
 * never cookie-bearing browsers) reads it.
 */
export function mountRoomsApp(
	app: Hono<Env>,
	opts: { ownership: OwnershipRule },
): void {
	app.use(
		ROOM_ROUTE.prefixPattern,
		normalizeWebSocketAuth,
		requireBearerUser,
		createRequireOwnership(opts.ownership),
	);
	app.route('/', roomsApp);
	// Room destruction is owner-wide and irreversible; expose it only where the
	// owner partition is a single user (personal mode). See {@link roomsDeleteApp}.
	if (opts.ownership.kind === 'personal') {
		app.route('/', roomsDeleteApp);
	}
}
