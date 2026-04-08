/**
 * Creates a KvHelper from a pre-created YKeyValue store.
 *
 * Provides typed get/set/delete/observe methods over a backing store.
 * KV uses validate-or-default semantics: invalid or missing data returns
 * the default value from the KV definition.
 *
 * This is the primary building block for KV construction, used by
 * createWorkspace (which creates the store for encryption coordination)
 * and by tests.
 */

import type { YKeyValueLwwChange } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import type { EncryptedYKeyValueLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type { KvChange, KvDefinitions, KvHelper } from './types.js';

/**
 * Creates a KvHelper with typed get/set/delete/observe methods.
 *
 * All KV logic lives here. Used by createWorkspace (which creates the
 * store itself for encryption coordination).
 *
 * @param ykv - The backing YKeyValue store (encrypted or passthrough)
 * @param definitions - Map of key name to KvDefinition
 * @returns KvHelper with type-safe get/set/delete/observe methods
 */
export function createKv<TKvDefinitions extends KvDefinitions>(
	ykv: EncryptedYKeyValueLww<unknown>,
	definitions: TKvDefinitions,
): KvHelper<TKvDefinitions> {
	return {
		get(key) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const raw = ykv.get(key);
			if (raw === undefined) return definition.defaultValue;

			const result = definition.schema['~standard'].validate(raw);
			if (result instanceof Promise)
				throw new TypeError('Async schemas not supported');
			if (result.issues) return definition.defaultValue;

			return result.value;
		},

		set(key, value) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			ykv.set(key, value);
		},

		delete(key) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			ykv.delete(key);
		},

		observe(key, callback) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				origin: unknown,
			) => {
				const change = changes.get(key);
				if (!change) return;

				switch (change.action) {
					case 'delete':
						callback({ type: 'delete' }, origin);
						break;
					case 'add':
					case 'update': {
						const result = definition.schema['~standard'].validate(
							change.newValue,
						);
						if (!(result instanceof Promise) && !result.issues) {
							callback(
								{ type: 'set', value: result.value } as Parameters<
									typeof callback
								>[0],
								origin,
							);
						}
						// Skip callback for invalid values
						break;
					}
				}
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		observeAll(
			callback: (
				changes: Map<string, KvChange<unknown>>,
				origin: unknown,
			) => void,
		) {
			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				origin: unknown,
			) => {
				const parsed = new Map<string, KvChange<unknown>>();
				for (const [key, change] of changes) {
					const definition = definitions[key];
					if (!definition) continue;
					if (change.action === 'delete') {
						parsed.set(key, { type: 'delete' });
					} else {
						const result = definition.schema['~standard'].validate(
							change.newValue,
						);
						if (!(result instanceof Promise) && !result.issues) {
							parsed.set(key, {
								type: 'set',
								value: result.value,
							});
						}
					}
				}
				if (parsed.size > 0) callback(parsed, origin);
			};
			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},
	} as KvHelper<TKvDefinitions>;
}
