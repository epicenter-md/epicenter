import {
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
	poison: Error | undefined;
	durability: Promise<void>;
	listener(update: Uint8Array): void;
};

/**
 * Open the same-thread row-document owner (ADR-0135). One Y.Doc is cached per
 * live row address and every emitted update persists automatically.
 */
export function createDocumentRuntime({
	sqlite,
	admitIntent,
	readParts,
	readCurrentRow,
}: {
	sqlite: RowSyncSqlite;
	admitIntent(intent: WireRowIntent): void | Promise<void>;
	readParts(table: string, rowId: string): Uint8Array[];
	readCurrentRow(table: string, rowId: string): unknown | undefined;
}) {
	initializeCanonicalSchema(sqlite);
	const cached = new Map<string, CachedDocument>();

	function keyOf({ table, rowId }: Address): string {
		return `${table}\0${rowId}`;
	}

	function asError(cause: unknown): Error {
		return cause instanceof Error ? cause : new Error(String(cause));
	}

	function assertWritable(entry: CachedDocument): void {
		if (entry.poison) throw entry.poison;
		if (entry.leases === 0) {
			throw new Error('Row document handle is disposed');
		}
	}

	function poison(entry: CachedDocument, cause: unknown): void {
		entry.poison ??= asError(cause);
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
		return {
			get: ((...args: Parameters<Y.Doc['get']>) => {
				if (disposed) throw new Error('Row document handle is disposed');
				if (entry.poison) throw entry.poison;
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
				if (entry.poison) throw entry.poison;
			},
			[Symbol.dispose]() {
				if (disposed) return;
				disposed = true;
				entry.leases -= 1;
				if (entry.leases === 0) finishLastLease(entry);
			},
		};
	}

	return {
		async open(table: string, rowId: string): Promise<RowDocument> {
			if (readCurrentRow(table, rowId) === undefined) {
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

			const doc = new Y.Doc();
			try {
				for (const part of readParts(table, rowId)) Y.applyUpdate(doc, part);
				if (readCurrentRow(table, rowId) === undefined) {
					throw new Error(
						`Cannot open document for absent row '${table}.${rowId}'`,
					);
				}
				const entry: CachedDocument = {
					...address,
					doc,
					leases: 1,
					poison: undefined,
					durability: Promise.resolve(),
					listener(update) {
						assertWritable(entry);
						const captured = Uint8Array.from(update);
						const persistence = entry.durability.then(async () => {
							if (entry.poison) throw entry.poison;
							if (readCurrentRow(table, rowId) === undefined) return;
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
				const key = keyOf(address);
				const entry = cached.get(key);
				if (!entry) continue;
				poison(
					entry,
					new Error(
						`Row document was revoked because '${address.table}.${address.rowId}' was deleted`,
					),
				);
				cached.delete(key);
				entry.doc.off('update', entry.listener);
				entry.doc.destroy();
			}
		},
	};
}

export type DocumentRuntime = ReturnType<typeof createDocumentRuntime>;

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
