/**
 * Row-body runtime over the sequence-addressed update log (ADR-0133).
 *
 * A body is row-owned with no public identity. Local edits persist as opaque
 * CRDT updates in one SQLite transaction together with their `bodyAppend`
 * sync command, so the durability acknowledgement IS the transaction commit:
 * an edit that acknowledged survives any crash, an edit interrupted before it
 * never happened. Accepted updates from other replicas install into the
 * replica's body table keyed by their authority sequence; hydration merges
 * both sources, and Yjs idempotence makes the overlap between a pending
 * command and its accepted echo harmless.
 *
 * Offline parking needs no mechanism: a row's create precedes its appends in
 * the same outbox order, so the authority folds them in order.
 */
import type { RecordCommand, RecordSyncSqlite } from '@epicenter/record-sync';
import * as Y from 'yjs';

const LOCAL_LOG_TABLE = '__epicenter_bodies_log';
const ACCEPTED_TABLE = '__epicenter_replica_bodies';

/** Merge the local log into one baseline once it grows past this depth. */
const LOCAL_COMPACTION_THRESHOLD = 64;

export type CanonicalBodiesOptions = {
	/**
	 * Admit one schema-opaque synchronization command in the same SQLite
	 * transaction as its durable local update. A standalone owner may omit
	 * this hook; edits then stay device-local in the log.
	 */
	admit?(command: RecordCommand): void;
};

export type OpenedCanonicalBody = {
	/** The live collaborative document; its one root is named 'body'. */
	doc: Y.Doc;
	/**
	 * Resolves once every edit issued so far is durably committed. With a
	 * synchronous SQLite owner this is immediate; the surface exists so
	 * editors can coordinate close and discard without knowing the storage
	 * engine's latency.
	 */
	whenDurable(): Promise<void>;
	/** Apply accepted updates that arrived since the body was opened. */
	refresh(): void;
	[Symbol.dispose](): void;
};

/**
 * Open the private body owner for one canonical store. Format selection and
 * table gating live in the runtime; this owner is format-opaque.
 */
export function createCanonicalBodies(
	sqlite: RecordSyncSqlite,
	{ admit }: CanonicalBodiesOptions = {},
) {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS "${LOCAL_LOG_TABLE}" (
			ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
			table_name TEXT NOT NULL,
			row_id TEXT NOT NULL,
			update_b64 TEXT NOT NULL
		) STRICT
	`);

	function hasAcceptedTable(): boolean {
		return (
			sqlite.all<{ present: number }>(
				`SELECT 1 AS present FROM sqlite_master
				 WHERE type = 'table' AND name = ?`,
				[ACCEPTED_TABLE],
			).length > 0
		);
	}

	function readAccepted(
		table: string,
		rowId: string,
		afterSequence: number,
	): { update: Uint8Array; sequence: number }[] {
		if (!hasAcceptedTable()) return [];
		return sqlite
			.all<{ update_b64: string; last_server_sequence: number }>(
				`SELECT update_b64, last_server_sequence FROM "${ACCEPTED_TABLE}"
				 WHERE table_name = ? AND row_id = ? AND last_server_sequence > ?
				 ORDER BY last_server_sequence`,
				[table, rowId, afterSequence],
			)
			.map((stored) => ({
				update: decodeBase64(stored.update_b64),
				sequence: stored.last_server_sequence,
			}));
	}

	function readLocalLog(table: string, rowId: string): Uint8Array[] {
		return sqlite
			.all<{ update_b64: string }>(
				`SELECT update_b64 FROM "${LOCAL_LOG_TABLE}"
				 WHERE table_name = ? AND row_id = ? ORDER BY ordinal`,
				[table, rowId],
			)
			.map((stored) => decodeBase64(stored.update_b64));
	}

	function compactLocalLog(table: string, rowId: string): void {
		const updates = readLocalLog(table, rowId);
		if (updates.length <= LOCAL_COMPACTION_THRESHOLD) return;
		const merged = encodeBase64(Y.mergeUpdates(updates));
		sqlite.transaction(() => {
			sqlite.run(
				`DELETE FROM "${LOCAL_LOG_TABLE}" WHERE table_name = ? AND row_id = ?`,
				[table, rowId],
			);
			sqlite.run(
				`INSERT INTO "${LOCAL_LOG_TABLE}"(table_name, row_id, update_b64)
				 VALUES (?, ?, ?)`,
				[table, rowId, merged],
			);
		});
	}

	return {
		/**
		 * Open one row's body. Edits made through the returned doc persist
		 * durably and admit their sync command on every Yjs transaction.
		 */
		open(table: string, rowId: string): OpenedCanonicalBody {
			compactLocalLog(table, rowId);
			const doc = new Y.Doc();
			let lastSeenSequence = 0;

			const applyAccepted = () => {
				for (const accepted of readAccepted(table, rowId, lastSeenSequence)) {
					Y.applyUpdate(doc, accepted.update, 'canonical-bodies');
					lastSeenSequence = Math.max(lastSeenSequence, accepted.sequence);
				}
			};
			applyAccepted();
			for (const update of readLocalLog(table, rowId)) {
				Y.applyUpdate(doc, update, 'canonical-bodies');
			}

			const persist = (update: Uint8Array, origin: unknown) => {
				if (origin === 'canonical-bodies') return;
				const encoded = encodeBase64(update);
				sqlite.transaction(() => {
					sqlite.run(
						`INSERT INTO "${LOCAL_LOG_TABLE}"(table_name, row_id, update_b64)
						 VALUES (?, ?, ?)`,
						[table, rowId, encoded],
					);
					admit?.({
						kind: 'bodyAppend',
						table,
						rowId,
						update: encoded,
					});
				});
			};
			doc.on('update', persist);

			return {
				doc,
				async whenDurable() {
					// Persistence runs synchronously inside the update event;
					// once control returns to the caller, everything issued is
					// committed. Async engines replace this with a real barrier.
				},
				refresh: applyAccepted,
				[Symbol.dispose]() {
					doc.off('update', persist);
					doc.destroy();
				},
			};
		},

		/** Purge every local update for one row (its deletion is permanent). */
		purgeRow(table: string, rowId: string): void {
			sqlite.run(
				`DELETE FROM "${LOCAL_LOG_TABLE}" WHERE table_name = ? AND row_id = ?`,
				[table, rowId],
			);
		},
	};
}

export type CanonicalBodies = ReturnType<typeof createCanonicalBodies>;

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
