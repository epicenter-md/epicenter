/**
 * createKv() - Lower-level API for binding KV definitions to an existing Y.Doc.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { createKv, defineKv } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
 *
 * // Builder pattern for multiple versions with migration (use _v discriminant)
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'", _v: '"1"' }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
 *   .migrate((v) => {
 *     if (v._v === '1') return { ...v, fontSize: 14, _v: '2' };
 *     return v;
 *   });
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const kv = createKv(ydoc, { sidebar, theme });
 *
 * kv.set('sidebar', { collapsed: false, width: 300 });
 * kv.set('theme', { mode: 'system', fontSize: 16, _v: '2' });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { KV_KEY } from '../shared/ydoc-keys.js';
import type {
	InferKvValue,
	KvBatchTransaction,
	KvDefinition,
	KvDefinitions,
	KvGetResult,
	KvHelper,
} from './types.js';

/**
 * Binds KV definitions to an existing Y.Doc.
 *
 * Creates a KvHelper with dictionary-style access methods.
 * All KV values are stored in a shared Y.Array at `kv`.
 *
 * @param ydoc - The Y.Doc to bind KV to
 * @param definitions - Map of key name to KvDefinition
 * @returns KvHelper with type-safe get/set/delete/observe methods
 */
export function createKv<TKvDefinitions extends KvDefinitions>(
	ydoc: Y.Doc,
	definitions: TKvDefinitions,
): KvHelper<TKvDefinitions> {
	// All KV values share a single YKeyValueLww store
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const ykv = new YKeyValueLww(yarray);

	/**
	 * Parse and migrate a raw value using the given definition.
	 */
	function parseValue<TValue>(
		raw: unknown,
		definition: KvDefinition<readonly StandardSchemaV1[]>,
	): KvGetResult<TValue> {
		const result = definition.schema['~standard'].validate(raw);
		if (result instanceof Promise)
			throw new TypeError('Async schemas not supported');

		if (result.issues) {
			return {
				status: 'invalid',
				errors: result.issues,
				value: raw,
			};
		}

		// Migrate to latest version
		const migrated = definition.migrate(result.value);
		return { status: 'valid', value: migrated as TValue };
	}

	return {
		get(key) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const raw = ykv.get(key);
			if (raw === undefined) {
				return { status: 'not_found', value: undefined };
			}
			return parseValue(raw, definition);
		},

		set(key, value) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			ykv.set(key, value);
		},

		delete(key) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			ykv.delete(key);
		},

		batch(fn) {
			ykv.doc.transact(() => {
				fn({
					set: (key, value) => {
						if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
						ykv.set(key, value);
					},
					delete: (key) => {
						if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
						ykv.delete(key);
					},
				} as KvBatchTransaction<TKvDefinitions>);
			});
		},

		observe(key, callback) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				transaction: Y.Transaction,
			) => {
				const change = changes.get(key);
				if (!change) return;

				switch (change.action) {
					case 'delete':
						callback({ type: 'delete' }, transaction);
						break;
					case 'add':
					case 'update': {
						// Parse and migrate the new value
						const parsed = parseValue(change.newValue, definition);
						if (parsed.status === 'valid') {
							callback(
								{ type: 'set', value: parsed.value } as Parameters<
									typeof callback
								>[0],
								transaction,
							);
						}
						// Skip callback for invalid values (could add an error callback if needed)
						break;
					}
				}
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},
	} as KvHelper<TKvDefinitions>;
}

// Re-export types for convenience
export type { InferKvValue, KvDefinition, KvDefinitions, KvHelper };
