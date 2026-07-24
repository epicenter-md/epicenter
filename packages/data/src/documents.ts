import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import * as Y from '@y/y';

import { sha256HexBytes } from './protocol/index.js';
import type { Replica } from './replica/index.js';

const COMPACTION_THRESHOLD = 64;
const hydrationOrigin = Object.freeze({ kind: 'epicenter-document-hydration' });

/**
 * The one transaction origin that marks an applied update as authority
 * accepted. Only bytes the authority has already committed and fanned out may
 * carry it: the persist listener stores them durably without minting a new
 * publication obligation. Everything else, whatever its origin value, is
 * locally authored work that must reach the authority (ADR-0174).
 */
export const acceptedDocumentOrigin = Object.freeze({
	kind: 'epicenter-authority-accepted',
});

/**
 * Who authored one appended update. `local` work advances the durable
 * publication revision in the append transaction; `accepted` bytes already
 * carry authority proof and leave no new obligation (ADR-0171/0174).
 */
export type DocumentUpdateSource = 'local' | 'accepted';

/** One immutable frozen publication attempt (ADR-0171 retry image). */
export type DocumentPublicationImage = {
	update: Uint8Array;
	digest: string;
	revision: number;
};

export type DocumentPublicationStatus = {
	revision: number;
	acceptedRevision: number;
	parkedRevision: number | undefined;
	inflightDigest: string | undefined;
};

type StoredPublication = SqliteRow & {
	revision: number;
	accepted_revision: number;
	parked_revision: number | null;
	inflight_revision: number | null;
	inflight_digest: string | null;
	inflight_update: Uint8Array | ArrayBuffer | null;
};

export type DocumentAddress = { key: string; rowId: string };

type StoredUpdate = SqliteRow & {
	update_sequence: number;
	update_bytes: Uint8Array | ArrayBuffer;
};

type DocumentEntry = {
	address: DocumentAddress;
	document: LiveDocument;
	references: number;
	revoked: Error | undefined;
	revocationListeners: Set<(error: Error) => void>;
	stopPersistence(): void;
};

type UpdateListener = (update: Uint8Array, origin: unknown) => void;

type LiveDocument = Y.Doc & {
	on(name: 'updateV2', listener: UpdateListener): UpdateListener;
	off(name: 'updateV2', listener: UpdateListener): void;
	destroy(): void;
};

export type RowDocumentConnectionTarget = {
	address: DocumentAddress;
	applyUpdate(update: Uint8Array, origin?: unknown): void;
	encodeStateVector(): Uint8Array;
	encodeStateAsUpdate(stateVector?: Uint8Array): Uint8Array;
	observe(listener: UpdateListener): () => void;
	subscribeRevocation(listener: (error: Error) => void): () => void;
};

const rowDocumentAccess = new WeakMap<
	RowDocument,
	RowDocumentConnectionTarget
>();

export function registerRowDocumentConnectionTarget(
	document: RowDocument,
	target: RowDocumentConnectionTarget,
): void {
	rowDocumentAccess.set(document, target);
}

export type RowDocument = {
	get: Y.Doc['get'];
	transact<TValue>(
		callback: (transaction: Y.Transaction) => TValue,
		origin?: unknown,
	): TValue;
	whenDurable(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

export function createDocumentRuntime({
	database,
	replica,
}: {
	database: SqliteDatabase;
	replica: Replica;
}) {
	const entries = new Map<string, DocumentEntry>();
	const opening = new Map<string, Promise<DocumentEntry>>();
	let isDisposed = false;

	function addressKey({ key, rowId }: DocumentAddress): string {
		return JSON.stringify([key, rowId]);
	}

	function requireRuntimeOpen(): void {
		if (isDisposed) throw new Error('Epicenter document runtime is disposed');
	}

	function isRowLive({ key, rowId }: DocumentAddress): boolean {
		const result = replica.readRow(key, rowId);
		if (result.error !== null) throw result.error;
		return result.data !== undefined;
	}

	function requireRowLive(address: DocumentAddress): void {
		if (isRowLive(address)) return;
		throw new Error(
			`Cannot open document for absent row '${address.key}.${address.rowId}'`,
		);
	}

	function readUpdates(address: DocumentAddress): StoredUpdate[] {
		return database.all<StoredUpdate>(
			`SELECT update_sequence, update_bytes
			 FROM document_updates
			 WHERE qualified_key = ? AND row_id = ?
			 ORDER BY update_sequence`,
			[address.key, address.rowId],
		);
	}

	function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
		return value instanceof Uint8Array
			? new Uint8Array(value)
			: new Uint8Array(value.slice(0));
	}

	function readPublication(
		address: DocumentAddress,
	): StoredPublication | undefined {
		return database.all<StoredPublication>(
			`SELECT revision, accepted_revision, parked_revision,
			        inflight_revision, inflight_digest, inflight_update
			 FROM document_publication
			 WHERE qualified_key = ? AND row_id = ?`,
			[address.key, address.rowId],
		)[0];
	}

	function replay(updates: readonly StoredUpdate[]): LiveDocument {
		const document = new Y.Doc({ gc: true }) as LiveDocument;
		try {
			for (const update of updates) {
				Y.applyUpdateV2(document, copyBytes(update.update_bytes));
			}
			return document;
		} catch (cause) {
			document.destroy();
			throw cause;
		}
	}

	function append(
		address: DocumentAddress,
		update: Uint8Array,
		source: DocumentUpdateSource,
	): void {
		database.transaction(() => {
			if (!isRowLive(address)) {
				throw new Error(
					`Cannot persist document update for absent row '${address.key}.${address.rowId}'`,
				);
			}
			const nextSequence =
				database.all<SqliteRow & { sequence: number }>(
					`SELECT COALESCE(MAX(update_sequence), 0) + 1 AS sequence
					 FROM document_updates
					 WHERE qualified_key = ? AND row_id = ?`,
					[address.key, address.rowId],
				)[0]?.sequence ?? 1;
			database.run(
				`INSERT INTO document_updates (
					qualified_key, row_id, update_sequence, update_bytes
				) VALUES (?, ?, ?, ?)`,
				[address.key, address.rowId, nextSequence, new Uint8Array(update)],
			);
			// Durable bytes and their publication obligation commit together: a
			// crash can never separate locally authored work from the revision
			// that makes the drain republish it (ADR-0171).
			if (source === 'local') {
				database.run(
					`INSERT INTO document_publication (
						qualified_key, row_id, revision, accepted_revision
					) VALUES (?, ?, 1, 0)
					ON CONFLICT (qualified_key, row_id) DO UPDATE SET
						revision = revision + 1`,
					[address.key, address.rowId],
				);
			}
			const updates = readUpdates(address);
			if (updates.length < COMPACTION_THRESHOLD) return;
			const compacted = replay(updates);
			try {
				const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
				database.run(
					'DELETE FROM document_updates WHERE qualified_key = ? AND row_id = ?',
					[address.key, address.rowId],
				);
				database.run(
					`INSERT INTO document_updates (
						qualified_key, row_id, update_sequence, update_bytes
					) VALUES (?, ?, 1, ?)`,
					[address.key, address.rowId, baseline],
				);
			} finally {
				compacted.destroy();
			}
		});
	}

	function createEntry(address: DocumentAddress): DocumentEntry {
		requireRowLive(address);
		const document = new Y.Doc({ gc: true }) as LiveDocument;
		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === hydrationOrigin) return;
			append(
				address,
				update,
				origin === acceptedDocumentOrigin ? 'accepted' : 'local',
			);
		};
		document.on('updateV2', persist);
		try {
			for (const update of readUpdates(address)) {
				Y.applyUpdateV2(
					document,
					copyBytes(update.update_bytes),
					hydrationOrigin,
				);
			}
			requireRowLive(address);
			const entry: DocumentEntry = {
				address: { ...address },
				document,
				references: 0,
				revoked: undefined,
				revocationListeners: new Set(),
				stopPersistence() {
					document.off('updateV2', persist);
				},
			};
			entries.set(addressKey(address), entry);
			return entry;
		} catch (cause) {
			document.off('updateV2', persist);
			document.destroy();
			throw cause;
		}
	}

	async function entryFor(address: DocumentAddress): Promise<DocumentEntry> {
		requireRuntimeOpen();
		const cacheKey = addressKey(address);
		const existing = entries.get(cacheKey);
		if (existing !== undefined) return existing;
		const pending = opening.get(cacheKey);
		if (pending !== undefined) return pending;
		const created = Promise.resolve().then(() => createEntry({ ...address }));
		opening.set(cacheKey, created);
		try {
			return await created;
		} finally {
			if (opening.get(cacheKey) === created) opening.delete(cacheKey);
		}
	}

	function destroyEntry(entry: DocumentEntry): void {
		const cacheKey = addressKey(entry.address);
		if (entries.get(cacheKey) === entry) entries.delete(cacheKey);
		entry.stopPersistence();
		entry.document.destroy();
	}

	function createHandle(entry: DocumentEntry): RowDocument {
		let isHandleDisposed = false;
		entry.references += 1;

		function requireUsable(): void {
			if (isHandleDisposed) throw new Error('Row document handle is disposed');
			if (entry.revoked !== undefined) throw entry.revoked;
		}

		const handle: RowDocument = {
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return entry.document.get(...args);
			}) as Y.Doc['get'],
			transact<TValue>(
				callback: (transaction: Y.Transaction) => TValue,
				origin?: unknown,
			): TValue {
				requireUsable();
				return entry.document.transact(callback, origin);
			},
			async whenDurable(): Promise<void> {
				requireUsable();
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (isHandleDisposed) return;
				isHandleDisposed = true;
				entry.references -= 1;
				if (entry.references === 0 && entry.revoked === undefined) {
					destroyEntry(entry);
				}
			},
		};
		registerRowDocumentConnectionTarget(handle, {
			address: { ...entry.address },
			applyUpdate(update, origin) {
				requireUsable();
				Y.applyUpdateV2(entry.document, new Uint8Array(update), origin);
			},
			encodeStateVector() {
				requireUsable();
				return new Uint8Array(Y.encodeStateVector(entry.document));
			},
			encodeStateAsUpdate(stateVector) {
				requireUsable();
				return new Uint8Array(
					Y.encodeStateAsUpdateV2(entry.document, stateVector),
				);
			},
			observe(listener) {
				requireUsable();
				entry.document.on('updateV2', listener);
				return () => entry.document.off('updateV2', listener);
			},
			subscribeRevocation(listener) {
				if (entry.revoked !== undefined) {
					listener(entry.revoked);
					return () => undefined;
				}
				entry.revocationListeners.add(listener);
				return () => entry.revocationListeners.delete(listener);
			},
		});
		return handle;
	}

	return {
		async open(address: DocumentAddress): Promise<RowDocument> {
			const entry = await entryFor(address);
			requireRuntimeOpen();
			if (entry.revoked !== undefined) throw entry.revoked;
			return createHandle(entry);
		},
		/**
		 * The durable authority-publication obligation for row documents
		 * (ADR-0171/0174). Owned here because obligation state must commit in
		 * the same SQLite transactions as the update chain it describes; the
		 * runtime-owned drain reads and settles it through these operations and
		 * never through an open document handle.
		 */
		publication: {
			/** Addresses owing publication, stable address order, parked excluded. */
			listDirty(): DocumentAddress[] {
				return database
					.all<SqliteRow & { qualified_key: string; row_id: string }>(
						`SELECT qualified_key, row_id FROM document_publication
						 WHERE revision > accepted_revision
						   AND (parked_revision IS NULL OR revision > parked_revision)
						 ORDER BY qualified_key, row_id`,
					)
					.map(({ qualified_key, row_id }) => ({
						key: qualified_key,
						rowId: row_id,
					}));
			},
			/**
			 * Freeze one immutable publication attempt for a dirty address, or
			 * return the already frozen image so a lost response retries the
			 * exact same bytes. Chain read, hydration, and freeze share one
			 * transaction; a racing local edit lands as a newer revision and
			 * never mutates the frozen image.
			 */
			freeze(address: DocumentAddress): DocumentPublicationImage | undefined {
				return database.transaction(() => {
					const record = readPublication(address);
					if (!record || record.revision <= record.accepted_revision) {
						return undefined;
					}
					if (
						record.inflight_revision !== null &&
						record.inflight_digest !== null &&
						record.inflight_update !== null
					) {
						return {
							update: copyBytes(record.inflight_update),
							digest: record.inflight_digest,
							revision: record.inflight_revision,
						};
					}
					if (
						record.parked_revision !== null &&
						record.revision <= record.parked_revision
					) {
						return undefined;
					}
					const updates = readUpdates(address);
					if (updates.length === 0) return undefined;
					const hydrated = replay(updates);
					let complete: Uint8Array;
					try {
						complete = new Uint8Array(Y.encodeStateAsUpdateV2(hydrated));
					} finally {
						hydrated.destroy();
					}
					const image: DocumentPublicationImage = {
						update: complete,
						digest: sha256HexBytes(complete),
						revision: record.revision,
					};
					database.run(
						`UPDATE document_publication SET
							inflight_revision = ?, inflight_digest = ?, inflight_update = ?
						 WHERE qualified_key = ? AND row_id = ?`,
						[
							image.revision,
							image.digest,
							image.update,
							address.key,
							address.rowId,
						],
					);
					return image;
				});
			},
			/**
			 * Clear the frozen image only when the post-commit receipt matches
			 * its digest exactly, and mark the address clean only when no newer
			 * local revision arrived after the freeze. A stale or foreign
			 * receipt changes nothing; a lost receipt retries the same bytes.
			 */
			settle(address: DocumentAddress, receipt: { digest: string }): void {
				database.transaction(() => {
					const record = readPublication(address);
					if (!record || record.inflight_digest !== receipt.digest) return;
					database.run(
						`UPDATE document_publication SET
							accepted_revision = max(accepted_revision, inflight_revision),
							parked_revision = NULL,
							inflight_revision = NULL,
							inflight_digest = NULL,
							inflight_update = NULL
						 WHERE qualified_key = ? AND row_id = ?`,
						[address.key, address.rowId],
					);
				});
			},
			/**
			 * Record a bound refusal for the current revision. The address stays
			 * durably owed but leaves the drain until a later local edit
			 * advances past the parked revision (ADR-0174 parked work).
			 */
			park(address: DocumentAddress): void {
				database.run(
					`UPDATE document_publication SET
						parked_revision = revision,
						inflight_revision = NULL,
						inflight_digest = NULL,
						inflight_update = NULL
					 WHERE qualified_key = ? AND row_id = ?`,
					[address.key, address.rowId],
				);
			},
			/**
			 * Drop the frozen retry image without settling, keeping the address
			 * dirty. Used when the authority reports the row not live; the
			 * scalar plane delivers the deletion that removes the whole record.
			 */
			clearInflight(address: DocumentAddress): void {
				database.run(
					`UPDATE document_publication SET
						inflight_revision = NULL,
						inflight_digest = NULL,
						inflight_update = NULL
					 WHERE qualified_key = ? AND row_id = ?`,
					[address.key, address.rowId],
				);
			},
			/** Durable obligation state for one address, or undefined if none. */
			status(address: DocumentAddress): DocumentPublicationStatus | undefined {
				const record = readPublication(address);
				if (!record) return undefined;
				return {
					revision: record.revision,
					acceptedRevision: record.accepted_revision,
					parkedRevision: record.parked_revision ?? undefined,
					inflightDigest: record.inflight_digest ?? undefined,
				};
			},
		},
		revoke(address: DocumentAddress): void {
			const entry = entries.get(addressKey(address));
			if (entry === undefined) return;
			entry.revoked = new Error(
				`Row document was revoked because '${address.key}.${address.rowId}' is no longer live`,
			);
			for (const listener of entry.revocationListeners) {
				listener(entry.revoked);
			}
			entry.revocationListeners.clear();
			destroyEntry(entry);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			await Promise.allSettled(opening.values());
			for (const entry of [...entries.values()]) {
				entry.revoked = new Error('Epicenter document runtime is disposed');
				for (const listener of entry.revocationListeners) {
					listener(entry.revoked);
				}
				entry.revocationListeners.clear();
				destroyEntry(entry);
			}
		},
	};
}

function requireRowDocumentAccess(
	document: RowDocument,
): RowDocumentConnectionTarget {
	const access = rowDocumentAccess.get(document);
	if (access === undefined) throw new Error('Unknown row document handle');
	return access;
}

/** Apply one incremental V2 update at an adapter boundary. */
export function applyRowDocumentUpdate(
	document: RowDocument,
	update: Uint8Array,
	origin?: unknown,
): void {
	requireRowDocumentAccess(document).applyUpdate(update, origin);
}

/** Encode one initial state snapshot for an adapter boundary. */
export function encodeRowDocumentState(document: RowDocument): Uint8Array {
	return requireRowDocumentAccess(document).encodeStateAsUpdate();
}

/** Observe incremental V2 updates at an adapter boundary. */
export function observeRowDocumentUpdates(
	document: RowDocument,
	listener: UpdateListener,
): () => void {
	return requireRowDocumentAccess(document).observe(listener);
}

/** Expose the narrow transport seam for one locally owned row document. */
export function rowDocumentConnectionTarget(
	document: RowDocument,
): RowDocumentConnectionTarget {
	return requireRowDocumentAccess(document);
}
