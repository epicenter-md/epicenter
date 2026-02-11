/**
 * TableHelper implementation for versioned table operations.
 *
 * Provides CRUD operations with validation and migration on read.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as Y from 'yjs';
import type {
	YKeyValueLww,
	YKeyValueLwwChange,
} from '../shared/y-keyvalue/y-keyvalue-lww.js';
import type {
	DeleteResult,
	GetResult,
	InferTableRow,
	InvalidRowResult,
	RowResult,
	TableBatchTransaction,
	TableDefinition,
	TableHelper,
	UpdateResult,
} from './types.js';

/**
 * Creates a TableHelper for a single table bound to a YKeyValue store.
 */
export function createTableHelper<
	TVersions extends readonly StandardSchemaV1[],
>(
	ykv: YKeyValueLww<unknown>,
	definition: TableDefinition<TVersions>,
): TableHelper<InferTableRow<TableDefinition<TVersions>>> {
	type TRow = InferTableRow<TableDefinition<TVersions>>;
	/**
	 * Parse and migrate a raw row value. Injects `id` into the input before validation.
	 */
	function parseRow(id: string, input: unknown): RowResult<TRow> {
		const row = { ...(input as Record<string, unknown>), id };
		const result = definition.schema['~standard'].validate(row);
		if (result instanceof Promise)
			throw new TypeError('Async schemas not supported');
		if (result.issues)
			return { status: 'invalid', id, errors: result.issues, row };
		// Migrate to latest version
		const migrated = definition.migrate(result.value);
		return { status: 'valid', row: migrated };
	}

	return {
		// ═══════════════════════════════════════════════════════════════════════
		// PARSE
		// ═══════════════════════════════════════════════════════════════════════

		parse(id: string, input: unknown): RowResult<TRow> {
			return parseRow(id, input);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// WRITE
		// ═══════════════════════════════════════════════════════════════════════

		set(row: TRow): void {
			ykv.set(row.id, row);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// UPDATE
		// ═══════════════════════════════════════════════════════════════════════

		update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow> {
			const current = this.get(id);
			if (current.status !== 'valid') return current;

			const merged = { ...current.row, ...partial, id };
			const result = parseRow(id, merged);
			if (result.status === 'invalid') return result;

			this.set(result.row);
			return { status: 'updated', row: result.row };
		},

		// ═══════════════════════════════════════════════════════════════════════
		// READ
		// ═══════════════════════════════════════════════════════════════════════

		get(id: string): GetResult<TRow> {
			const raw = ykv.get(id);
			if (raw === undefined) {
				return { status: 'not_found', id, row: undefined };
			}
			return parseRow(id, raw);
		},

		getAll(): RowResult<TRow>[] {
			const results: RowResult<TRow>[] = [];
			for (const [key, entry] of ykv.map) {
				const result = parseRow(key, entry.val);
				results.push(result);
			}
			return results;
		},

		getAllValid(): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.map) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid') {
					rows.push(result.row);
				}
			}
			return rows;
		},

		getAllInvalid(): InvalidRowResult[] {
			const invalid: InvalidRowResult[] = [];
			for (const [key, entry] of ykv.map) {
				const result = parseRow(key, entry.val);
				if (result.status === 'invalid') {
					invalid.push(result);
				}
			}
			return invalid;
		},

		// ═══════════════════════════════════════════════════════════════════════
		// QUERY
		// ═══════════════════════════════════════════════════════════════════════

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.map) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					rows.push(result.row);
				}
			}
			return rows;
		},

		find(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const [key, entry] of ykv.map) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					return result.row;
				}
			}
			return undefined;
		},

		// ═══════════════════════════════════════════════════════════════════════
		// DELETE
		// ═══════════════════════════════════════════════════════════════════════

		delete(id: string): DeleteResult {
			if (!ykv.has(id)) {
				return { status: 'not_found_locally' };
			}
			ykv.delete(id);
			return { status: 'deleted' };
		},

		clear(): void {
			const keys = Array.from(ykv.map.keys());
			for (const key of keys) {
				ykv.delete(key);
			}
		},

		// ═══════════════════════════════════════════════════════════════════════
		// BATCH (Y.js transaction for atomicity)
		// ═══════════════════════════════════════════════════════════════════════

		batch(fn: (tx: TableBatchTransaction<TRow>) => void): void {
			ykv.doc.transact(() => {
				fn({
					set: (row: TRow) => ykv.set(row.id, row),
					delete: (id: string) => ykv.delete(id),
				});
			});
		},

		// ═══════════════════════════════════════════════════════════════════════
		// OBSERVE
		// ═══════════════════════════════════════════════════════════════════════

		observe(
			callback: (changedIds: Set<string>, transaction: unknown) => void,
		): () => void {
			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				transaction: Y.Transaction,
			) => {
				callback(new Set(changes.keys()), transaction);
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// METADATA
		// ═══════════════════════════════════════════════════════════════════════

		count(): number {
			return ykv.map.size;
		},

		has(id: string): boolean {
			return ykv.has(id);
		},
	};
}
