/**
 * Typed release-local KV lens over the reserved immortal row (ADR-0130/0132).
 * Unknown and nonconforming values remain untouched in the canonical map.
 */
import {
	foldFields,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	type RowSyncSqlite,
	type WireRowIntent,
} from '@epicenter/row-sync';
import { Ok, type Result } from 'wellcrafted/result';
import {
	initializeCanonicalSchema,
	readCurrentRow,
} from './canonical-replica.js';
import {
	compileKvLens,
	type KvDefinitions,
	KvReadError,
	type KvReadError as KvReadErrorType,
	type KvValues,
	KvWriteError,
	type KvWriteError as KvWriteErrorType,
} from './kv-definition.js';
import type { JsonObject, JsonValue } from './lens-definition.js';

const ROWS_TABLE = 'rows';

export type CanonicalKvOptions = {
	/** Synchronized mode admits the reserved row's field-bearing update intent. */
	admitIntent?(intent: WireRowIntent): void;
	onLocalCommit?(): void;
};

export type CanonicalKv<TDefinitions extends KvDefinitions> = {
	get<K extends keyof TDefinitions & string>(
		key: K,
	): Result<KvValues<TDefinitions>[K] | undefined, KvReadErrorType>;
	set<K extends keyof TDefinitions & string>(
		key: K,
		value: KvValues<TDefinitions>[K],
	): Result<void, KvWriteErrorType>;
	unset<K extends keyof TDefinitions & string>(key: K): void;
};

export function createCanonicalKv<const TDefinitions extends KvDefinitions>(
	sqlite: RowSyncSqlite,
	definitions: TDefinitions,
	{ admitIntent, onLocalCommit = () => undefined }: CanonicalKvOptions = {},
): CanonicalKv<TDefinitions> {
	initializeCanonicalSchema(sqlite);
	const lens = compileKvLens(definitions);

	function readMap(): JsonObject {
		return readCurrentRow(sqlite, RESERVED_KV_TABLE, RESERVED_KV_ROW_ID) ?? {};
	}

	function requireDeclared(key: string): { check(value: unknown): boolean } {
		const compiled = lens.get(key);
		if (!compiled) throw new Error(`Unknown kv key '${key}'`);
		return compiled;
	}

	function admit(intent: WireRowIntent): void {
		if (admitIntent) {
			admitIntent(structuredClone(intent));
			return;
		}
		sqlite.transaction(() => {
			const current = readCurrentRow(
				sqlite,
				RESERVED_KV_TABLE,
				RESERVED_KV_ROW_ID,
			);
			const folded = foldFields(current, intent);
			if (folded.kind !== 'fields') return;
			sqlite.run(
				`INSERT INTO "${ROWS_TABLE}"(table_key, row_id, fields_json)
				 VALUES (?, ?, ?)
				 ON CONFLICT(table_key, row_id) DO UPDATE SET
					fields_json = excluded.fields_json`,
				[RESERVED_KV_TABLE, RESERVED_KV_ROW_ID, JSON.stringify(folded.fields)],
			);
			onLocalCommit();
		});
	}

	return {
		get(key) {
			requireDeclared(key);
			const map = readMap();
			if (!Object.hasOwn(map, key)) return Ok(undefined);
			const raw = map[key] as JsonValue;
			if (!requireDeclared(key).check(raw)) {
				return KvReadError.NonconformingKvValue({
					key,
					raw: structuredClone(raw),
				});
			}
			return Ok(structuredClone(raw) as never);
		},
		set(key, value) {
			const compiled = requireDeclared(key);
			if (!compiled.check(value)) {
				return KvWriteError.InvalidKvWrite({
					key,
					reason: 'value does not satisfy the declared schema',
				});
			}
			admit({
				kind: 'update',
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				fields: {
					set: { [key]: structuredClone(value) as JsonValue },
					unset: [],
				},
			});
			return Ok(undefined);
		},
		unset(key) {
			requireDeclared(key);
			admit({
				kind: 'update',
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				fields: { set: {}, unset: [key] },
			});
		},
	};
}
