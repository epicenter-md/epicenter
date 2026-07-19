/**
 * Typed release-local KV lens over the reserved immortal row (ADR-0130/0132).
 * Unknown and nonconforming values remain untouched in the canonical map.
 */
import { RESERVED_KV_ROW_ID, RESERVED_KV_TABLE } from '@epicenter/row-sync';
import { Ok, type Result } from 'wellcrafted/result';
import type { CanonicalStore } from './canonical-store.js';
import {
	compileKvLens,
	type KvDefinitions,
	KvReadError,
	type KvReadError as KvReadErrorType,
	type KvValues,
	KvWriteError,
	type KvWriteError as KvWriteErrorType,
} from './kv-definition.js';
import type { JsonValue } from './lens-definition.js';

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

/** Open one release-local KV lens over a schema-opaque canonical store. */
export function createCanonicalKvView<const TDefinitions extends KvDefinitions>(
	store: CanonicalStore,
	definitions: TDefinitions,
): CanonicalKv<TDefinitions> {
	const lens = compileKvLens(definitions);

	function readMap() {
		return store.read(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID) ?? {};
	}

	function requireDeclared(key: string): { check(value: unknown): boolean } {
		const compiled = lens.get(key);
		if (!compiled) throw new Error(`Unknown kv key '${key}'`);
		return compiled;
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
			store.admit({
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
			store.admit({
				kind: 'update',
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				fields: { set: {}, unset: [key] },
			});
		},
	};
}
