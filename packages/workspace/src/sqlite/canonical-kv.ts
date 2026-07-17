/**
 * The canonical KV client (ADR-0130/0132).
 *
 * KV is one reserved immortal record inside the canonical record map:
 * `kv.set` compiles to `patchRow` at `__epicenter_kv/workspace`, `kv.unset`
 * to its `unset`, and the aggregate inherits the outbox, sealed rounds,
 * ordering, snapshots, and compaction of rows with no machinery of its own.
 *
 * Reads are honest: a conforming value, `undefined` for absence, or a
 * nonconforming error carrying the raw stored value. Nothing here heals,
 * defaults, migrates, or deletes unknown keys.
 */
import {
	foldRow,
	type RecordCommand,
	type RecordSyncSqlite,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
} from '@epicenter/row-sync';
import { Ok, type Result } from 'wellcrafted/result';
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

const RECORDS_TABLE = '__epicenter_records';

export type CanonicalKvOptions = {
	/**
	 * Admit one schema-opaque synchronization command in the same SQLite
	 * transaction as its optimistic canonical write. A standalone owner may
	 * omit this hook.
	 */
	admit?(command: RecordCommand): void;
};

export type CanonicalKv<TDefinitions extends KvDefinitions> = {
	/** Read one declared key: value, `undefined` for absence, or the raw error. */
	get<K extends keyof TDefinitions & string>(
		key: K,
	): Result<KvValues<TDefinitions>[K] | undefined, KvReadErrorType>;
	/** Validate and write one declared key. Nested values replace atomically. */
	set<K extends keyof TDefinitions & string>(
		key: K,
		value: KvValues<TDefinitions>[K],
	): Result<void, KvWriteErrorType>;
	/** Return one declared key to absence. No tombstone, no stored default. */
	unset<K extends keyof TDefinitions & string>(key: K): void;
	/** Observe one declared key. Fires after any local or installed change. */
	observe<K extends keyof TDefinitions & string>(
		key: K,
		handler: () => void,
	): () => void;
	/**
	 * Runtime hook: re-evaluate observers after remote state installs. The
	 * synchronization owner calls this from its remote-commit path.
	 */
	notifyExternalChange(): void;
};

/**
 * Open the typed KV lens over one canonical record store. The records table
 * must already exist (the canonical records owner creates it).
 */
export function createCanonicalKv<const TDefinitions extends KvDefinitions>(
	sqlite: RecordSyncSqlite,
	definitions: TDefinitions,
	{ admit = () => undefined }: CanonicalKvOptions = {},
): CanonicalKv<TDefinitions> {
	const lens = compileKvLens(definitions);
	const observers = new Map<string, Set<() => void>>();
	const lastSeen = new Map<string, string | undefined>();

	function readMap(): JsonObject {
		const stored = sqlite.all<{ payload: string }>(
			`SELECT payload FROM "${RECORDS_TABLE}" WHERE table_key = ? AND row_id = ?`,
			[RESERVED_KV_TABLE, RESERVED_KV_ROW_ID],
		)[0];
		return stored ? (JSON.parse(stored.payload) as JsonObject) : {};
	}

	function requireDeclared(key: string): { check(value: unknown): boolean } {
		const compiled = lens.get(key);
		if (!compiled) throw new Error(`Unknown kv key '${key}'`);
		return compiled;
	}

	function fire(key: string): void {
		lastSeen.set(key, encodeCurrent(key));
		for (const handler of observers.get(key) ?? []) handler();
	}

	function encodeCurrent(key: string): string | undefined {
		const map = readMap();
		return Object.hasOwn(map, key) ? JSON.stringify(map[key]) : undefined;
	}

	function writeFolded(command: RecordCommand, value: JsonObject): void {
		sqlite.transaction(() => {
			admit(structuredClone(command));
			sqlite.run(
				`INSERT INTO "${RECORDS_TABLE}"(table_key, row_id, payload)
				 VALUES (?, ?, ?)
				 ON CONFLICT(table_key, row_id) DO UPDATE SET payload = excluded.payload`,
				[RESERVED_KV_TABLE, RESERVED_KV_ROW_ID, JSON.stringify(value)],
			);
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
			const command: RecordCommand = {
				kind: 'patchRow',
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				set: { [key]: structuredClone(value) as JsonValue } as JsonObject,
				unset: [],
			};
			const current = readMap();
			const folded = foldRow(
				Object.keys(current).length === 0 ? undefined : current,
				command,
			);
			if (folded.kind !== 'row') {
				return KvWriteError.InvalidKvWrite({
					key,
					reason: 'the composed KV aggregate exceeds its capacity cap',
				});
			}
			writeFolded(command, folded.value);
			fire(key);
			return Ok(undefined);
		},
		unset(key) {
			requireDeclared(key);
			const command: RecordCommand = {
				kind: 'patchRow',
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				set: {},
				unset: [key],
			};
			const current = readMap();
			const folded = foldRow(
				Object.keys(current).length === 0 ? undefined : current,
				command,
			);
			if (folded.kind !== 'row') return;
			writeFolded(command, folded.value);
			fire(key);
		},
		observe(key, handler) {
			requireDeclared(key);
			let handlers = observers.get(key);
			if (!handlers) {
				handlers = new Set();
				observers.set(key, handlers);
			}
			handlers.add(handler);
			if (!lastSeen.has(key)) lastSeen.set(key, encodeCurrent(key));
			return () => {
				handlers.delete(handler);
				if (handlers.size === 0) observers.delete(key);
			};
		},
		notifyExternalChange() {
			for (const key of observers.keys()) {
				const current = encodeCurrent(key);
				if (lastSeen.get(key) !== current) fire(key);
			}
		},
	};
}
