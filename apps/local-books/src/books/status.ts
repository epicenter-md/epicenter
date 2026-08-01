/**
 * `readBooksStatus`: the connection-and-mirror state of one company, read from
 * the token store, the mirror site's artifact inventory, and the mirror's `_meta`
 * table. Where `queryBooks` answers row-level questions, this answers "are you
 * connected, and how fresh is the local copy?": the cheap orientation read.
 *
 * There is no stored-shape check to report. The artifact is named by the
 * declaration's fingerprint (ADR-0194), so the honest questions are "does the
 * current materialization exist" and "what earlier ones are still on disk", both
 * answered by `artifacts()` without opening SQLite.
 *
 * It is a plain reader, not a `Result`: "not connected" and "mirror not built"
 * are reported states, not failures, so the shape is always returned. The
 * `status` CLI verb formats this for a human; the MCP `status` tool hands the
 * same object straight back as structured content (ADR-0072 leaves this seam
 * open exactly as it does for the other verb cores).
 */

import type { AppConfig, QbEnvironment } from '../config.ts';
import { type EntityStatus, openBooksDbReadonly } from '../db.ts';
import { entityDef } from '../entities.ts';
import type { MirrorSite } from '../mirror.ts';
import type { TokenStore } from '../token-store.ts';
import { isAccessTokenExpired, isRefreshTokenExpired } from '../tokens.ts';

export type TokenStatus = {
	/** False once the token is past its expiry (with the usual refresh skew for access). */
	valid: boolean;
	expiresAt: string;
};

export type BooksStatus = {
	realmId: string;
	environment: QbEnvironment;
	dataDir: string;
	tokenFile: string;
	/** Whether a token is stored for this realm at all. */
	connected: boolean;
	/** Null when not connected. */
	accessToken: TokenStatus | null;
	refreshToken: TokenStatus | null;
	/** Whether the current mirror artifact exists yet (a `sync --full` builds it). */
	mirrorBuilt: boolean;
	/**
	 * The current artifact's path, whether or not it exists yet. Named by the
	 * declaration's fingerprint, so it is not a path a reader can guess: this is
	 * how a human or an agent finds the file to point `sqlite3` at.
	 */
	mirrorPath: string;
	/**
	 * Fingerprints of earlier artifacts still on disk beside the current one. A
	 * declaration edit renames the artifact and retains its predecessor, so this is
	 * non-empty until an app-owned reclaim runs. It is inventory, not a mismatch:
	 * nothing here is consulted by any read path.
	 */
	predecessors: string[];
	/** The remaining fields are null/empty until the mirror is built. */
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
	entities: EntityStatus[];
};

/** Read the connection + mirror state for one realm. Never throws on "absent". */
export async function readBooksStatus({
	config,
	realmId,
	mirror,
	store,
}: {
	config: AppConfig;
	realmId: string;
	mirror: MirrorSite;
	store: TokenStore;
}): Promise<BooksStatus> {
	const token = await store.get(realmId);
	const now = Date.now();
	const base = {
		realmId,
		environment: config.environment,
		dataDir: config.dataDir,
		tokenFile: config.credentialsPath,
		connected: token !== null,
		accessToken: token
			? {
					valid: !isAccessTokenExpired(token, now, 0),
					expiresAt: token.accessTokenExpiresAt,
				}
			: null,
		refreshToken: token
			? {
					valid: !isRefreshTokenExpired(token, now),
					expiresAt: token.refreshTokenExpiresAt,
				}
			: null,
	};

	// Artifact inventory is a directory read, so it answers "which shapes exist
	// here" even when the current one has never been built.
	const shape = {
		mirrorPath: mirror.path,
		predecessors: mirror
			.artifacts()
			.filter((a) => !a.current)
			.map((a) => a.fingerprint),
	};

	// Read-only: a status read must not block on a concurrent sync's write lock,
	// and must never create the artifact it is reporting on.
	const db = openBooksDbReadonly(mirror);
	if (db === null) {
		return {
			...base,
			...shape,
			mirrorBuilt: false,
			cdcCursor: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
			entities: [],
		};
	}
	try {
		const realm = db.readRealmState();
		return {
			...base,
			...shape,
			mirrorBuilt: true,
			cdcCursor: realm.cdcCursor,
			lastFullPullAt: realm.lastFullPullAt,
			lastSyncedAt: realm.lastSyncedAt,
			entities: config.entities.map((name) => db.entityStatus(entityDef(name))),
		};
	} finally {
		db.close();
	}
}
