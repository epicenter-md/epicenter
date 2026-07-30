/**
 * KV definition types and the `createKv` builder. `createWorkspace` (in
 * `./workspace.ts`) consumes these to mount the KV slot onto a workspace root.
 *
 * Read is a hopeful projection: `get()` returns the stored value when it is
 * present and valid, otherwise the definition's `defaultValue()`. Absent and
 * invalid values read as the default. The read never persists that default;
 * invalid stored bytes are left untouched until an explicit write repairs them.
 *
 * The plane is bounded by construction: only declared keys are admitted, and
 * key and encoded-value budgets are enforced at write time.
 */

import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { KvStoreChange, ObservableKvStore } from './y-keyvalue/index';

// ════════════════════════════════════════════════════════════════════════════
// KV RESULT TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Change event for KV observation. */
export type KvChange<TValue> =
	| { type: 'set'; value: TValue }
	| { type: 'delete' };

// ════════════════════════════════════════════════════════════════════════════
// KV BUDGETS
// ════════════════════════════════════════════════════════════════════════════

/** Maximum UTF-8 byte length of a declared KV key. */
const MAX_KV_KEY_BYTES = 512;

/** Maximum UTF-8 byte length of one JSON-encoded KV value. */
const MAX_KV_VALUE_BYTES = 64 * 1024;

const utf8 = new TextEncoder();

// ════════════════════════════════════════════════════════════════════════════
// KV DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A KV definition created by `defineKv(schema, defaultValue)`.
 *
 * `defaultValue` is always a factory: the library calls it on every default
 * firing, so each call returns a fresh value safe to mutate.
 */
/** Nominal identity carried only by defineKv factory products. */
declare const kvDefinitionBrand: unique symbol;

export type KvDefinition<S extends TSchema = TSchema> = {
	readonly schema: S;
	readonly defaultValue: () => Static<S>;
	readonly [kvDefinitionBrand]: true;
};

/** Extract the value type from a KvDefinition. */
export type InferKvValue<T> =
	T extends KvDefinition<infer S> ? Static<S> : never;

/** Map of KV definitions (uses `any` to allow variance in generic parameters). */
export type KvDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	KvDefinition<any>
>;

/**
 * Dictionary-style typed handle over a KV store.
 */
export type Kv<TKvDefinitions extends KvDefinitions> = ReturnType<
	typeof createKv<TKvDefinitions>
>;

/**
 * Build a Kv helper over any `ObservableKvStore`. Consumed by
 * `createWorkspace` over the underlying YKV store.
 *
 * Throws at construction when a declared key exceeds
 * {@link MAX_KV_KEY_BYTES}. Every accessor throws on an undeclared key
 * instead of silently misbehaving.
 */
export function createKv<TKvDefinitions extends KvDefinitions>(
	ykv: ObservableKvStore<unknown>,
	definitions: TKvDefinitions,
) {
	const keys = Object.keys(definitions) as Array<keyof TKvDefinitions & string>;

	for (const key of keys) {
		if (utf8.encode(key).byteLength > MAX_KV_KEY_BYTES) {
			throw new Error(
				`KV key '${key}' exceeds the ${MAX_KV_KEY_BYTES}-byte key budget`,
			);
		}
	}

	function definitionFor<K extends keyof TKvDefinitions & string>(
		key: K,
	): TKvDefinitions[K] {
		const definition = definitions[key];
		if (!definition) throw new Error(`Unknown KV key '${key}'`);
		return definition;
	}

	function assertValueBudget(key: string, value: unknown): void {
		const encoded = utf8.encode(JSON.stringify(value)).byteLength;
		if (encoded > MAX_KV_VALUE_BYTES) {
			throw new Error(
				`KV value for '${key}' is ${encoded} bytes; the budget is ${MAX_KV_VALUE_BYTES} bytes`,
			);
		}
	}

	return {
		/** Every defined key, in declaration order. */
		keys,

		get<K extends keyof TKvDefinitions & string>(
			key: K,
		): InferKvValue<TKvDefinitions[K]> {
			const definition = definitionFor(key);
			const raw = ykv.get(key);
			if (raw !== undefined && Value.Check(definition.schema, raw)) {
				return raw as InferKvValue<TKvDefinitions[K]>;
			}
			// Absent and invalid values read as the default. The stored bytes are
			// left intact until an explicit write repairs them.
			return definition.defaultValue() as InferKvValue<TKvDefinitions[K]>;
		},

		set<K extends keyof TKvDefinitions & string>(
			key: K,
			value: InferKvValue<TKvDefinitions[K]>,
		): void {
			definitionFor(key);
			assertValueBudget(key, value);
			ykv.set(key, value);
		},

		/**
		 * The default value for a key, factory-evaluated: each call returns a
		 * fresh value safe to mutate. The schema stays the single source of
		 * defaults; callers never redeclare them.
		 */
		getDefault<K extends keyof TKvDefinitions & string>(
			key: K,
		): InferKvValue<TKvDefinitions[K]> {
			return definitionFor(key).defaultValue() as InferKvValue<
				TKvDefinitions[K]
			>;
		},

		/**
		 * Write every key's default in one batch (one observer firing, not one
		 * per key), via the store's `bulkSet`.
		 */
		reset(): void {
			ykv.bulkSet(
				keys.map((key) => {
					const val = definitionFor(key).defaultValue();
					assertValueBudget(key, val);
					return { key, val };
				}),
			);
		},

		delete<K extends keyof TKvDefinitions & string>(key: K): void {
			definitionFor(key);
			ykv.delete(key);
		},

		/**
		 * Observe one key's effective value.
		 *
		 * When an invalid winning value arrives (a stored value that fails the
		 * declared schema), observers are notified with the EFFECTIVE change
		 * `{ type: 'set', value: defaultValue() }`, matching what `get()` now
		 * returns. The invalid stored bytes are left untouched.
		 */
		observe<K extends keyof TKvDefinitions & string>(
			key: K,
			callback: (
				change: KvChange<InferKvValue<TKvDefinitions[K]>>,
				origin?: unknown,
			) => void,
		): () => void {
			const definition = definitionFor(key);

			const handler = (
				changes: Map<string, KvStoreChange<unknown>>,
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
						const value = Value.Check(definition.schema, change.newValue)
							? change.newValue
							: // An invalid winning value reads as a fresh default; notify
								// the effective change so readers re-render with `get()`.
								definition.defaultValue();
						callback(
							{
								type: 'set',
								value: value as InferKvValue<TKvDefinitions[K]>,
							},
							origin,
						);
						break;
					}
					default:
						change satisfies never;
				}
			};

			return ykv.observe(handler);
		},

		/**
		 * Observe every declared key at once.
		 *
		 * Follows the same effective-change contract as `observe`: an invalid
		 * winning value is reported as `{ type: 'set', value: defaultValue() }`
		 * while the stored bytes stay untouched.
		 */
		observeAll(
			callback: (
				changes: Map<keyof TKvDefinitions & string, KvChange<unknown>>,
				origin?: unknown,
			) => void,
		): () => void {
			const handler = (
				changes: Map<string, KvStoreChange<unknown>>,
				origin: unknown,
			) => {
				const parsed = new Map<string, KvChange<unknown>>();
				for (const [key, change] of changes) {
					const definition = definitions[key];
					if (!definition) continue;
					if (change.action === 'delete') {
						parsed.set(key, { type: 'delete' });
					} else if (Value.Check(definition.schema, change.newValue)) {
						parsed.set(key, { type: 'set', value: change.newValue });
					} else {
						// Effective change: the invalid winner reads as a fresh default.
						parsed.set(key, { type: 'set', value: definition.defaultValue() });
					}
				}
				if (parsed.size > 0) {
					callback(
						parsed as Map<keyof TKvDefinitions & string, KvChange<unknown>>,
						origin,
					);
				}
			};
			return ykv.observe(handler);
		},

		getAll(): {
			[K in keyof TKvDefinitions & string]: InferKvValue<TKvDefinitions[K]>;
		} {
			const result = {} as {
				[K in keyof TKvDefinitions & string]: InferKvValue<TKvDefinitions[K]>;
			};
			for (const key of Object.keys(definitions)) {
				const typedKey = key as keyof TKvDefinitions & string;
				result[typedKey] = this.get(typedKey);
			}
			return result;
		},
	};
}
