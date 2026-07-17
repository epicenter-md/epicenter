import {
	decodeBase64,
	encodeBase64,
	ROW_SYNC_ADMISSION_LIMITS,
	type RowSyncSqlite,
	type WireRowIntent,
} from '@epicenter/row-sync';
import * as Y from '@y/y';
import { initializeCanonicalSchema } from './canonical-replica.js';

export type RowDocument = {
	get: Y.Doc['get'];
	/**
	 * Groups application-authored changes into one local Yjs transaction.
	 *
	 * This deliberately withholds Yjs's third `local` parameter. Application
	 * writes are always local; provider authority remains runtime-owned.
	 */
	transact<TValue>(
		callback: (transaction: Y.Transaction) => TValue,
		origin?: unknown,
	): TValue;
	/** Wait until every update observed before this call has committed locally. */
	whenDurable(): Promise<void>;
	[Symbol.dispose](): void;
};

type Address = { table: string; rowId: string };

type CachedDocument = Address & {
	doc: Y.Doc;
	leases: number;
	/** A persistence failure: blocks new writes AND queued persistence. */
	poison: Error | undefined;
	/**
	 * A lifecycle revocation (row deletion, baseline promotion, runtime
	 * disposal): blocks new writes and reads, but updates captured before
	 * the revocation still drain to `admitIntent`, so an edit the user
	 * already made is never dropped by the handle lifecycle (ADR-0136).
	 */
	revoked: Error | undefined;
	durability: Promise<void>;
	listener(update: Uint8Array): void;
};

const ownedDocuments = new WeakMap<RowDocument, CachedDocument>();

/**
 * Open the row-document owner (ADR-0135). One Y.Doc is cached per live row
 * address and every emitted update persists automatically.
 */
export function createDocumentRuntime({
	admitIntent,
	readParts,
	readCurrentRow,
}: {
	admitIntent(intent: WireRowIntent): void | Promise<void>;
	readParts(table: string, rowId: string): Uint8Array[] | Promise<Uint8Array[]>;
	readCurrentRow(
		table: string,
		rowId: string,
	): unknown | undefined | Promise<unknown | undefined>;
}) {
	const cached = new Map<string, CachedDocument>();

	function keyOf({ table, rowId }: Address): string {
		return `${table}\0${rowId}`;
	}

	function asError(cause: unknown): Error {
		return cause instanceof Error ? cause : new Error(String(cause));
	}

	function assertWritable(entry: CachedDocument): void {
		if (entry.poison) throw entry.poison;
		if (entry.revoked) throw entry.revoked;
		if (entry.leases === 0) {
			throw new Error('Row document handle is disposed');
		}
	}

	function poison(entry: CachedDocument, cause: unknown): void {
		entry.poison ??= asError(cause);
	}

	/** Detach and destroy a revoked entry; captured persistence drains on. */
	function revokeEntry(entry: CachedDocument, cause: Error): void {
		entry.revoked ??= cause;
		cached.delete(keyOf(entry));
		entry.doc.off('update', entry.listener);
		entry.doc.destroy();
	}

	function finishLastLease(entry: CachedDocument): void {
		void entry.durability.then(() => {
			if (entry.leases !== 0) return;
			if (cached.get(keyOf(entry)) !== entry) return;
			entry.doc.off('update', entry.listener);
			entry.doc.destroy();
			cached.delete(keyOf(entry));
		});
	}

	function createHandle(entry: CachedDocument): RowDocument {
		let disposed = false;
		const handle: RowDocument = {
			get: ((...args: Parameters<Y.Doc['get']>) => {
				if (disposed) throw new Error('Row document handle is disposed');
				const failure = entry.poison ?? entry.revoked;
				if (failure) throw failure;
				return entry.doc.get(...args);
			}) as Y.Doc['get'],
			transact<TValue>(
				callback: (transaction: Y.Transaction) => TValue,
				origin?: unknown,
			): TValue {
				if (disposed) throw new Error('Row document handle is disposed');
				assertWritable(entry);
				return entry.doc.transact(callback, origin);
			},
			async whenDurable(): Promise<void> {
				if (disposed) throw new Error('Row document handle is disposed');
				const barrier = entry.durability;
				await barrier;
				const failure = entry.poison ?? entry.revoked;
				if (failure) throw failure;
			},
			[Symbol.dispose]() {
				if (disposed) return;
				disposed = true;
				entry.leases -= 1;
				if (entry.leases === 0) finishLastLease(entry);
			},
		};
		ownedDocuments.set(handle, entry);
		return handle;
	}

	return {
		async open(table: string, rowId: string): Promise<RowDocument> {
			if ((await readCurrentRow(table, rowId)) === undefined) {
				throw new Error(
					`Cannot open document for absent row '${table}.${rowId}'`,
				);
			}
			const address = { table, rowId };
			const key = keyOf(address);
			const existing = cached.get(key);
			if (existing) {
				if (existing.poison) throw existing.poison;
				existing.leases += 1;
				return createHandle(existing);
			}

			const parts = await readParts(table, rowId);
			if ((await readCurrentRow(table, rowId)) === undefined) {
				throw new Error(
					`Cannot open document for absent row '${table}.${rowId}'`,
				);
			}
			const hydratedExisting = cached.get(key);
			if (hydratedExisting) {
				if (hydratedExisting.poison) throw hydratedExisting.poison;
				hydratedExisting.leases += 1;
				return createHandle(hydratedExisting);
			}

			const doc = new Y.Doc();
			try {
				for (const part of parts) Y.applyUpdate(doc, part);
				const entry: CachedDocument = {
					...address,
					doc,
					leases: 1,
					poison: undefined,
					revoked: undefined,
					durability: Promise.resolve(),
					listener(update) {
						assertWritable(entry);
						const captured = Uint8Array.from(update);
						const persistence = entry.durability.then(async () => {
							// Only a persistence failure stops the chain: skipping one
							// captured update would leave a causal gap in front of its
							// successors. A lifecycle revocation does not cancel
							// captured persistence; the row-gone guard below drops
							// updates whose row has authoritatively died.
							if (entry.poison) throw entry.poison;
							if ((await readCurrentRow(table, rowId)) === undefined) return;
							await admitIntent({
								kind: 'update',
								table,
								rowId,
								documentUpdate: encodeBase64(captured),
							});
						});
						entry.durability = persistence.catch((cause) => {
							poison(entry, cause);
						});
					},
				};
				doc.on('update', entry.listener);
				cached.set(key, entry);
				return createHandle(entry);
			} catch (cause) {
				doc.destroy();
				throw cause;
			}
		},
		revoke(addresses: Address[]): void {
			for (const address of addresses) {
				const entry = cached.get(keyOf(address));
				if (!entry) continue;
				revokeEntry(
					entry,
					new Error(
						`Row document was revoked because '${address.table}.${address.rowId}' was deleted`,
					),
				);
			}
		},
		/**
		 * Revoke every cached handle. Baseline promotion calls this with no
		 * cause because promotion replaced every confirmed document
		 * (ADR-0136); runtime disposal passes its own cause. Callers
		 * explicitly reopen from the current state. Updates captured before
		 * the revocation still drain into durable intents.
		 */
		revokeAll(cause?: Error): void {
			for (const entry of [...cached.values()]) {
				revokeEntry(
					entry,
					cause ??
						new Error(
							'Row document was revoked because a baseline promotion replaced confirmed state',
						),
				);
			}
		},
	};
}

/** Runtime-only bridge for transporting one hydrated row document. */
export function encodeRowDocumentState(document: RowDocument): Uint8Array {
	const entry = ownedDocuments.get(document);
	if (!entry) throw new TypeError('Row document is not owned by this runtime');
	return Y.encodeStateAsUpdate(entry.doc);
}

/** Runtime-only bridge for applying one opaque transported update. */
export function applyRowDocumentUpdate(
	document: RowDocument,
	update: Uint8Array,
): void {
	const entry = ownedDocuments.get(document);
	if (!entry) throw new TypeError('Row document is not owned by this runtime');
	Y.applyUpdate(entry.doc, Uint8Array.from(update));
}

export type DocumentRuntime = ReturnType<typeof createDocumentRuntime>;

/** Persist document-bearing update intents directly in a local-only file. */
export function createLocalDocumentAdmission({
	sqlite,
	readCurrentRow,
	onLocalCommit = () => undefined,
}: {
	sqlite: RowSyncSqlite;
	readCurrentRow(table: string, rowId: string): unknown | undefined;
	onLocalCommit?: () => void;
}): (intent: WireRowIntent) => void {
	initializeCanonicalSchema(sqlite);
	return (intent) => {
		if (intent.kind !== 'update' || intent.documentUpdate === undefined) {
			throw new TypeError(
				'Local document persistence requires an update intent',
			);
		}
		sqlite.transaction(() => {
			if (readCurrentRow(intent.table, intent.rowId) === undefined) return;
			const incoming = decodeBase64(intent.documentUpdate as string);
			const stored = sqlite.all<{ yjs_state: Uint8Array }>(
				`SELECT yjs_state FROM documents
				 WHERE table_key = ? AND row_id = ?`,
				[intent.table, intent.rowId],
			)[0];
			const merged = mergeDocumentUpdates(
				stored ? [toBytes(stored.yjs_state), incoming] : [incoming],
			);
			sqlite.run(
				`INSERT INTO documents(table_key, row_id, yjs_state)
				 VALUES (?, ?, ?)
				 ON CONFLICT(table_key, row_id) DO UPDATE SET
					yjs_state = excluded.yjs_state`,
				[intent.table, intent.rowId, merged],
			);
			onLocalCommit();
		});
	};
}

/**
 * Compact ordered updates through fresh `gc: true` documents.
 *
 * `basePartCount` identifies the confirmed-plus-sealed prefix. The returned
 * component is the smaller of a complete compact state and the delta from that
 * base. Either representation reconstructs the same current document when
 * applied after the base.
 */
export function mergeDocumentUpdates(
	parts: readonly Uint8Array[],
	basePartCount = 0,
): Uint8Array {
	if (
		!Number.isSafeInteger(basePartCount) ||
		basePartCount < 0 ||
		basePartCount > parts.length
	) {
		throw new RangeError('Document base part count is out of range');
	}
	const base = new Y.Doc({ gc: true });
	const current = new Y.Doc({ gc: true });
	try {
		const ownedParts = parts.map((part) => Uint8Array.from(part));
		if (basePartCount > 0) {
			Y.applyUpdate(base, Y.mergeUpdates(ownedParts.slice(0, basePartCount)));
		}
		if (ownedParts.length > 0) {
			Y.applyUpdate(current, Y.mergeUpdates(ownedParts));
		}
		const fullState = Y.encodeStateAsUpdate(current);
		if (
			fullState.byteLength > ROW_SYNC_ADMISSION_LIMITS.canonicalDocumentBytes
		) {
			throw new RangeError('Canonical row document exceeds its size limit');
		}
		const delta = Y.encodeStateAsUpdate(current, Y.encodeStateVector(base));
		return delta.byteLength < fullState.byteLength ? delta : fullState;
	} finally {
		base.destroy();
		current.destroy();
	}
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}
