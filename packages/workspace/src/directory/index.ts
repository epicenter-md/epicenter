/**
 * The boxes directory: a tiny synced doc that tells every one of a user's
 * devices where their box lives.
 *
 * ADR-0079 splits cross-device into two planes. This module is the discovery
 * seam of the capability plane: the box is reached DIRECTLY (Epicenter is never
 * in the call path), so a device only needs to learn the box's address once.
 * Discovery rides the sync plane (the plane Epicenter already runs) rather than
 * a device-local scalar, because the value, a box's stable MagicDNS name, is a
 * non-secret fact that is identical on every device and worth syncing once
 * instead of re-entering per device.
 *
 * What it deliberately is NOT:
 *  - It is not new sync infrastructure. It is one `defineWorkspace` at a fixed
 *    reserved guid, opened with `.connect(connection)` using the same Yjs +
 *    IndexedDB + WebSocket machinery every other workspace already uses.
 *  - It carries addresses ONLY. There is NO token / secret / bearer column, by
 *    construction (the `noSecret` invariant test asserts this against the
 *    serialized doc). V0 has no box token at all: Tailscale ACLs are the authz
 *    (ADR-0079), so there is no credential to store or sync.
 *  - It never holds the books. Local Books stays the box's own SQLite, reached
 *    only through the box's `/mcp` tools; the directory holds the address, not
 *    the data.
 *
 * The guid is the single safe segment `epicenter-directory` (the same
 * `epicenter-<app>` grammar as every other workspace). The dotted reserved
 * `epicenter.account` grammar can NOT flow through `defineWorkspace` (its id
 * runs `assertSafeSegment`, which rejects a dot), and reusing the account room
 * would be wrong anyway: that room deliberately carries no data of its own and
 * is entangled with the floor.
 */

import { field } from '@epicenter/field';
import type { Brand } from 'wellcrafted/brand';
import {
	defineTable,
	defineWorkspace,
	generateId,
	type InferTableRow,
} from '../index.js';

export { capabilityUrls, type CapabilityUrls } from './capability-urls.js';

/** A box's stable id within the directory. Minted once when the box is registered. */
export type BoxId = string & Brand<'BoxId'>;

/** Mint a fresh {@link BoxId}. The one place the brand is applied. */
export const generateBoxId = (): BoxId => generateId<BoxId>();

/**
 * One row per box. Addresses only: `baseUrl` is the box's reachable origin (a
 * MagicDNS name like `https://mac-studio.<tailnet>.ts.net`), from which
 * `capabilityUrls` derives the `/mcp` and `/v1` suffixes. No token column, no
 * `activeBoxId`, no transport discriminator, no liveness field: a box's
 * reachability is probed by dialing it, never stored (ADR-0079).
 */
const boxesTable = defineTable({
	id: field.string<BoxId>(),
	/** Human label for the box, e.g. "Mac Studio". */
	label: field.string(),
	/** The box's reachable origin; `capabilityUrls(baseUrl)` derives `/mcp` + `/v1`. */
	baseUrl: field.string(),
	/** When the box was registered. The stable order key for listing boxes (LWW maps carry none). */
	createdAt: field.instant(),
});

/** A registered box: the address a device dials to reach the user's capability plane. */
export type Box = InferTableRow<typeof boxesTable>;

/**
 * The directory workspace definition. Isomorphic: every app opens it with
 * `directoryWorkspace.connect(connection)` using its existing signed-in config.
 */
export const directoryWorkspace = defineWorkspace({
	id: 'epicenter-directory',
	name: 'directory',
	tables: { boxes: boxesTable },
	kv: {},
});
