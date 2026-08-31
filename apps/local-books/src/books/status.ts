/**
 * `readBooksStatus`: the connection-and-mirror state of one company, read from
 * the token store, the mirror's artifact inventory, and the mirror's `_meta`
 * table. Where `queryBooks` answers row-level questions, this answers "are you
 * connected, and how fresh is the local copy?": the cheap orientation read.
 *
 * There is no stored-shape check to report. The artifact is named by the corpus
 * version that builds it (ADR-0197), so the honest questions are "how far along
 * is the current artifact" and "what older ones are still on disk". The second is
 * `versions()`, a directory read that opens no SQLite handle. The first is not:
 * a file existing proves only that something started writing, so readiness comes
 * from the realm's own cursor.
 *
 * It is a plain reader, not a `Result`: "not connected" and "mirror not built"
 * are reported states, not failures, so the shape is always returned. The
 * `status` CLI verb formats this for a human; the MCP `status` tool hands the
 * same object straight back as structured content (ADR-0072 leaves this seam
 * open exactly as it does for the other verb cores).
 */

import type { AppConfig, QbEnvironment } from '../config.ts';
import { type EntityStatus, openBooksDbReadonly } from '../db.ts';
import type { DbFile } from '../db-file.ts';
import { entityDef } from '../entities.ts';
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
	/**
	 * How much of the current artifact this build can trust. `empty` is no file at
	 * all; `building` is a file whose realm cursor has never been set, so a full
	 * pull has not finished and the rows in it are a partial corpus; `ready` is a
	 * cursor written by a clean full pull. A version bump lands in `empty` and
	 * passes through `building`, so the newest artifact is never authoritative
	 * merely for being newest.
	 */
	mirror: 'empty' | 'building' | 'ready';
	/**
	 * The current artifact's path, whether or not it exists yet. Named by the
	 * corpus version, so it changes under a reader that has not been rebuilt: this
	 * is how a human or an agent finds the file to point `sqlite3` at.
	 */
	mirrorPath: string;
	/**
	 * Versions of earlier artifacts still on disk beside the current one. A version
	 * bump names a new artifact and retains its predecessor, so this is non-empty
	 * until an app-owned reclaim runs. It is inventory, not a mismatch: nothing
	 * here is consulted by any read path.
	 */
	predecessors: number[];
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
	mirror: DbFile;
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

	// The version list is a directory read, so it answers "which shapes exist
	// here" even when the current one has never been built.
	const shape = {
		mirrorPath: mirror.path,
		predecessors: mirror
			.versions()
			.filter((v) => !v.current)
			.map((v) => v.version),
	};

	// Read-only: a status read must not block on a concurrent sync's write lock,
	// and must never create the artifact it is reporting on.
	const db = openBooksDbReadonly(mirror);
	if (db === null) {
		return {
			...base,
			...shape,
			mirror: 'empty',
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
			// The cursor is written only when a full pull finished with no failing
			// entity (`syncRealm`), so it is the one honest "this corpus is complete"
			// signal the mirror holds. A half-backfilled artifact reports `building`.
			mirror: realm.lastFullPullAt === null ? 'building' : 'ready',
			cdcCursor: realm.cdcCursor,
			lastFullPullAt: realm.lastFullPullAt,
			lastSyncedAt: realm.lastSyncedAt,
			entities: config.entities.map((name) => db.entityStatus(entityDef(name))),
		};
	} finally {
		db.close();
	}
}
