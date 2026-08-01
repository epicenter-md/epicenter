import { mailMirror, openMailDbReadonly } from './db.ts';
import type { LocalMailRuntime } from './runtime.ts';
import { isAccessTokenExpired } from './tokens.ts';

export type MailStatus = {
	accountEmail: string;
	dataDir: string;
	tokenFile: string;
	connected: boolean;
	accessToken: { valid: boolean; expiresAt: string } | null;
	mirror: 'empty' | 'building' | 'ready';
	/**
	 * The current artifact's path, whether or not it exists yet. It is named by
	 * the declaration's fingerprint, so it is not a path a reader can guess: this
	 * is how a human or an agent finds the file to point `sqlite3` at.
	 */
	mirrorPath: string;
	/**
	 * Fingerprints of earlier artifacts still on disk beside the current one. A
	 * declaration edit renames the artifact and retains its predecessor, so this
	 * is non-empty until a reclaim runs. It is inventory, not a mismatch: nothing
	 * here is consulted by any read path (ADR-0194).
	 */
	predecessors: string[];
	historyId: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
	rows: { messages: number; labels: number };
};

export async function readMailStatus({
	config,
	accountEmail,
	store,
}: LocalMailRuntime): Promise<MailStatus> {
	const token = await store.get(accountEmail);
	const base = {
		accountEmail,
		dataDir: config.dataDir,
		tokenFile: config.credentialsPath,
		connected: token !== null,
		accessToken: token
			? {
					valid: !isAccessTokenExpired(token, Date.now(), 0),
					expiresAt: token.accessTokenExpiresAt,
				}
			: null,
	};

	// Artifact inventory is a directory read, so it answers "which shapes exist
	// here" even when the current one has never been built. There is no stored
	// shape version to compare: the filename is the shape (ADR-0194).
	const site = mailMirror(config.dataDir, accountEmail);
	const shape = {
		mirrorPath: site.path,
		predecessors: site
			.artifacts()
			.filter((artifact) => !artifact.current)
			.map((artifact) => artifact.fingerprint),
	};

	// Read-only: a status read must not block on a concurrent sync's write lock,
	// and must never create the artifact it is reporting on.
	const db = openMailDbReadonly({ dataDir: config.dataDir, accountEmail });
	if (db === null) {
		return {
			...base,
			...shape,
			mirror: 'empty',
			historyId: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
			rows: { messages: 0, labels: 0 },
		};
	}
	try {
		const realm = db.realmState();
		return {
			...base,
			...shape,
			mirror: realm.historyId === null ? 'building' : 'ready',
			historyId: realm.historyId,
			lastFullPullAt: realm.lastFullPullAt,
			lastSyncedAt: realm.lastSyncedAt,
			rows: db.counts(),
		};
	} finally {
		db.close();
	}
}
