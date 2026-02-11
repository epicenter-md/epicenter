import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../../shared/y-keyvalue/y-keyvalue-lww';
import { KV_KEY } from '../../shared/ydoc-keys';
import type { KvField, KvFieldById, KvValue } from '../schema';

import {
	createKvHelper,
	type KvChange,
	type KvGetResult,
	type KvHelper,
} from './kv-helper';

export type { KvHelper } from './kv-helper';

/**
 * Flat Map-like API for accessing KV entries.
 *
 * The kv object provides direct methods: `kv.get('theme')`, `kv.set('theme', value)`.
 * This is simpler than the previous callable pattern and matches standard Map semantics.
 *
 * @example
 * ```typescript
 * kv.set('theme', 'dark');
 * kv.get('theme');  // { status: 'valid', value: 'dark' }
 * kv.reset('theme');
 * kv.has('theme');  // false (if no default)
 * ```
 */
export type KvFunction<TKvFields extends readonly KvField[]> = {
	// ════════════════════════════════════════════════════════════════════
	// KEY-VALUE OPERATIONS
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Get the value for a specific KV key.
	 *
	 * Returns a discriminated union with status:
	 * - `{ status: 'valid', value }` if value exists and passes validation
	 * - `{ status: 'invalid', key, error }` if value exists but fails validation
	 * - `{ status: 'not_found', key }` if value is unset (no default, not nullable)
	 *
	 * @example
	 * ```typescript
	 * const result = kv.get('theme');
	 * if (result.status === 'valid') {
	 *   console.log(result.value); // 'dark' | 'light'
	 * }
	 * ```
	 */
	get<K extends TKvFields[number]['id']>(
		key: K,
	): KvGetResult<KvValue<KvFieldById<TKvFields, K>>>;

	/**
	 * Set the value for a specific KV key.
	 *
	 * @example
	 * ```typescript
	 * kv.set('theme', 'dark');
	 * kv.set('count', 42);
	 * ```
	 */
	set<K extends TKvFields[number]['id']>(
		key: K,
		value: KvValue<KvFieldById<TKvFields, K>>,
	): void;

	/**
	 * Reset a specific KV key to its default value.
	 *
	 * If a default is defined in the schema, sets to that value.
	 * If nullable with no default, sets to null.
	 * Otherwise, deletes the key entirely.
	 *
	 * @example
	 * ```typescript
	 * kv.reset('theme'); // Back to schema default
	 * ```
	 */
	reset<K extends TKvFields[number]['id']>(key: K): void;

	/**
	 * Observe changes to a specific KV key.
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = kv.observeKey('theme', (change) => {
	 *   if (change.action !== 'delete') {
	 *     document.body.className = String(change.newValue);
	 *   }
	 * });
	 * ```
	 */
	observeKey<K extends TKvFields[number]['id']>(
		key: K,
		callback: (
			change: KvChange<KvValue<KvFieldById<TKvFields, K>>>,
			transaction: Y.Transaction,
		) => void,
	): () => void;

	// ════════════════════════════════════════════════════════════════════
	// EXISTENCE & ENUMERATION
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Check if a KV key has a value set in YJS storage.
	 */
	has(key: string): boolean;

	// ════════════════════════════════════════════════════════════════════
	// BULK OPERATIONS
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Clear all KV values, resetting them to their definition defaults.
	 */
	clear(): void;

	// ════════════════════════════════════════════════════════════════════
	// METADATA
	// ════════════════════════════════════════════════════════════════════

	/**
	 * The raw KV definitions passed to createKv.
	 */
	definitions: TKvFields;

	// ════════════════════════════════════════════════════════════════════
	// OBSERVATION
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Observe any KV changes. Callback is notified when any key changes.
	 */
	observe(callback: () => void): () => void;

	// ════════════════════════════════════════════════════════════════════
	// UTILITIES
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Serialize all KV values to a plain JSON object.
	 */
	toJSON(): {
		[K in TKvFields[number]['id']]: KvValue<KvFieldById<TKvFields, K>>;
	};
};

/**
 * Create a KV (key-value) store from definitions.
 *
 * Accepts an array of KvFields where each field's `.id` is the key.
 *
 * The returned object provides a flat Map-like API with direct methods:
 * `kv.get('key')`, `kv.set('key', value)`, `kv.reset('key')`.
 *
 * Uses YKeyValueLww for last-write-wins conflict resolution. Data is stored
 * as `{ key, val, ts }` entries in a Y.Array.
 *
 * Conceptually, a KV store is like a single table row where each key is a column.
 * While tables have multiple rows with IDs, KV stores have one "row" of settings/state.
 *
 * @param ydoc - The Y.Doc to store KV data in
 * @param kvFields - Array of KvFields where each field's `.id` is the key
 *
 * @example
 * ```typescript
 * const settings = createKv(ydoc, [
 *   select({ id: 'theme', name: 'Theme', options: ['light', 'dark'], default: 'light' }),
 *   integer({ id: 'fontSize', name: 'Font Size', default: 14 }),
 * ]);
 *
 * // Flat Map-like API
 * settings.set('theme', 'dark');
 * settings.set('fontSize', 16);
 * settings.get('theme');  // { status: 'valid', value: 'dark' }
 * settings.reset('theme'); // Back to default
 * ```
 */
export function createKv<const TKvFields extends readonly KvField[]>(
	ydoc: Y.Doc,
	kvFields: TKvFields,
): KvFunction<TKvFields> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<KvValue>>(KV_KEY);
	const ykvLww = new YKeyValueLww(yarray);

	// Build helpers map using field.id as the key
	const kvHelpers = Object.fromEntries(
		kvFields.map((field) => [field.id, createKvHelper({ ykvLww, field })]),
	) as Record<string, KvHelper<KvField>>;

	return {
		// ════════════════════════════════════════════════════════════════════
		// KEY-VALUE OPERATIONS
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Get the value for a specific KV key.
		 *
		 * Returns a discriminated union with status:
		 * - `{ status: 'valid', value }` if value exists and passes validation
		 * - `{ status: 'invalid', key, error }` if value exists but fails validation
		 * - `{ status: 'not_found', key }` if value is unset (no default, not nullable)
		 *
		 * @example
		 * ```typescript
		 * const result = kv.get('theme');
		 * if (result.status === 'valid') {
		 *   console.log(result.value); // 'dark' | 'light'
		 * }
		 * ```
		 */
		get<K extends TKvFields[number]['id']>(key: K) {
			return kvHelpers[key as string]!.get() as any;
		},

		/**
		 * Set the value for a specific KV key.
		 *
		 * @example
		 * ```typescript
		 * kv.set('theme', 'dark');
		 * kv.set('count', 42);
		 * ```
		 */
		set<K extends TKvFields[number]['id']>(
			key: K,
			value: KvValue<KvFieldById<TKvFields, K>>,
		) {
			kvHelpers[key as string]!.set(value);
		},

		/**
		 * Reset a specific KV key to its default value.
		 *
		 * If a default is defined in the schema, sets to that value.
		 * If nullable with no default, sets to null.
		 * Otherwise, deletes the key entirely.
		 *
		 * @example
		 * ```typescript
		 * kv.reset('theme'); // Back to schema default
		 * ```
		 */
		reset<K extends TKvFields[number]['id']>(key: K) {
			kvHelpers[key as string]!.reset();
		},

		/**
		 * Observe changes to a specific KV key.
		 *
		 * @example
		 * ```typescript
		 * const unsubscribe = kv.observeKey('theme', (change) => {
		 *   if (change.action !== 'delete') {
		 *     document.body.className = String(change.newValue);
		 *   }
		 * });
		 * ```
		 */
		observeKey<K extends TKvFields[number]['id']>(
			key: K,
			callback: (
				change: KvChange<KvValue<KvFieldById<TKvFields, K>>>,
				transaction: Y.Transaction,
			) => void,
		) {
			return kvHelpers[key as string]!.observe(callback as any);
		},

		// ════════════════════════════════════════════════════════════════════
		// EXISTENCE & ENUMERATION
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Check if a KV key has a value set in YJS storage.
		 *
		 * Returns true if a value has been explicitly set (even if it's null).
		 * Returns false if the key has never been set (will use default).
		 *
		 * @example
		 * ```typescript
		 * kv.has('theme')  // false (never set, will use default)
		 * kv.set('theme', 'dark')
		 * kv.has('theme')  // true
		 * ```
		 */
		has(key: string): boolean {
			return ykvLww.has(key);
		},

		// ════════════════════════════════════════════════════════════════════
		// BULK OPERATIONS
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Clear all KV values, resetting them to their definition defaults.
		 *
		 * Deletes all keys from the underlying storage. After clearing,
		 * `get()` will return defaults (if defined), `null` (if nullable),
		 * or `not_found` status.
		 *
		 * @example
		 * ```typescript
		 * kv.set('theme', 'dark');
		 * kv.set('fontSize', 20);
		 *
		 * kv.clear();
		 *
		 * kv.get('theme');    // { status: 'valid', value: 'light' } (default)
		 * kv.get('fontSize'); // { status: 'valid', value: 14 } (default)
		 * ```
		 */
		clear(): void {
			for (const field of kvFields) {
				ykvLww.delete(field.id);
			}
		},

		// ════════════════════════════════════════════════════════════════════
		// METADATA & ESCAPE HATCHES
		// ════════════════════════════════════════════════════════════════════

		/**
		 * The raw KV fields passed to createKv.
		 *
		 * Provides access to the full field definitions including metadata (name, icon, description)
		 * and the field schema. Useful for introspection, UI generation, or MCP/OpenAPI export.
		 *
		 * @example
		 * ```typescript
		 * // Access field metadata
		 * const themeField = kv.definitions.find(f => f.id === 'theme');
		 * console.log(themeField.name);        // 'Theme'
		 * console.log(themeField.icon);        // 'emoji:🎨'
		 * console.log(themeField.description); // 'Application color theme'
		 *
		 * // Access the field schema
		 * console.log(themeField.type);    // 'select'
		 * console.log(themeField.options); // ['light', 'dark']
		 *
		 * // Iterate over all fields
		 * for (const field of kv.definitions) {
		 *   console.log(`${field.name} (${field.id}): ${field.type}`);
		 * }
		 * ```
		 */
		definitions: kvFields,

		// ════════════════════════════════════════════════════════════════════
		// OBSERVATION
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Observe any KV changes. Callback is notified when any key changes.
		 *
		 * The observer just notifies that something changed. To get the current
		 * state, call `toJSON()` inside your callback or use individual key getters.
		 *
		 * @returns Unsubscribe function to stop observing
		 *
		 * @example
		 * ```typescript
		 * const unsubscribe = kv.observe(() => {
		 *   // Something changed - fetch current state if needed
		 *   const snapshot = kv.toJSON();
		 *   saveToFile(snapshot);
		 * });
		 *
		 * // Later, stop observing
		 * unsubscribe();
		 * ```
		 */
		observe(callback: () => void): () => void {
			// Wrap the callback to match YKeyValueLww's change handler signature
			const handler = () => callback();
			ykvLww.observe(handler);
			return () => ykvLww.unobserve(handler);
		},

		// ════════════════════════════════════════════════════════════════════
		// UTILITIES
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Serialize all KV values to a plain JSON object.
		 *
		 * Returns the raw storage contents. Keys may be missing if never set,
		 * and values may not match the schema (no validation performed).
		 * Useful for debugging, persistence, or API responses.
		 *
		 * @example
		 * ```typescript
		 * kv.set('theme', 'dark');
		 * kv.set('fontSize', 16);
		 *
		 * const json = kv.toJSON();
		 * // { theme: 'dark', fontSize: 16 }
		 *
		 * // Save to localStorage
		 * localStorage.setItem('settings', JSON.stringify(kv.toJSON()));
		 * ```
		 */
		toJSON(): {
			[K in TKvFields[number]['id']]: KvValue<KvFieldById<TKvFields, K>>;
		} {
			const result: Record<string, KvValue> = {};
			for (const [key, entry] of ykvLww.entries()) {
				result[key] = entry.val;
			}
			return result as {
				[K in TKvFields[number]['id']]: KvValue<KvFieldById<TKvFields, K>>;
			};
		},
	};
}

/**
 * Type alias for the return type of createKv.
 * Useful for typing function parameters that accept a KV instance.
 */
export type Kv<TKvFields extends readonly KvField[]> = ReturnType<
	typeof createKv<TKvFields>
>;
