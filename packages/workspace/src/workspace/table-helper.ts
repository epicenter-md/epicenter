/**
 * TableHelper implementation for versioned table operations.
 *
 * Provides CRUD operations with validation and migration on read.
 */

import type * as Y from 'yjs';
import type {
	YKeyValueLww,
	YKeyValueLwwChange,
} from '../shared/y-keyvalue/y-keyvalue-lww.js';
import type {
	GetResult,
	InferTableRow,
	InvalidRowResult,
	RowResult,
	TableDefinition,
	TableHelper,
	TransactionMeta,
	UpdateResult,
} from './types.js';

/**
 * Creates a TableHelper for a single table bound to a YKeyValue store.
 */
export function createTableHelper<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: YKeyValueLww<unknown>,
	definition: TTableDefinition,
): TableHelper<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;
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
		// Migrate to latest version. The cast is safe because `id` was injected
		// into the input above and preserved through validation + migration.
		const migrated = definition.migrate(result.value) as TRow;
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

		delete(id: string): void {
			ykv.delete(id);
		},

		clear(): void {
			const keys = Array.from(ykv.map.keys());
			for (const key of keys) {
				ykv.delete(key);
			}
		},

		// ═══════════════════════════════════════════════════════════════════════
		// OBSERVE
		// ═══════════════════════════════════════════════════════════════════════

		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>, transaction: TransactionMeta) => void,
		): () => void {
			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				transaction: Y.Transaction,
			) => {
				callback(new Set(changes.keys()) as ReadonlySet<TRow['id']>, transaction);
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
