import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SvelteMap } from 'svelte/reactivity';
import { trySync } from 'wellcrafted/result';
import { PersistedError } from './persisted-state.svelte.js';

// ── Types ────────────────────────────────────────────────────────────────────

type PersistedMapDefinition<TSchema extends StandardSchemaV1> = {
	schema: TSchema;
	defaultValue: NoInfer<StandardSchemaV1.InferOutput<TSchema>>;
};

type InferDefinitionValue<TDef> =
	TDef extends PersistedMapDefinition<infer TSchema>
		? StandardSchemaV1.InferOutput<TSchema>
		: never;

type PersistedMapOptions<
	TDefs extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
> = {
	/** Prefix for all storage keys. e.g., `'whispering.device.'` → `'whispering.device.apiKeys.openai'`. */
	prefix: string;
	/** Per-key schema and default value definitions. */
	definitions: TDefs;
	/**
	 * Called when a value read from storage fails to parse or validate.
	 * Fire-and-forget. `defaultValue` is used as the fallback regardless.
	 */
	onError?: (key: string, error: PersistedError) => void;
	/**
	 * Called when writing to storage fails (e.g., quota exceeded).
	 */
	onUpdateError?: (key: string, error: unknown) => void;
};

/**
 * Return type of `createPersistedMap`. Exported for consumers that need
 * an explicit type annotation (e.g., to break circular dependency inference).
 */
export type PersistedMap<
	TDefs extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
> = ReturnType<typeof createPersistedMap<TDefs>>;

// ── defineEntry ──────────────────────────────────────────────────────────────

/**
 * Type helper for defining a persisted map entry with schema and default value.
 * Ensures the `defaultValue` type is inferred from the schema, not the other way around.
 *
 * @example
 * ```ts
 * const DEFINITIONS = {
 *   'theme': defineEntry(type("'light' | 'dark'"), 'dark'),
 *   'fontSize': defineEntry(type('number'), 14),
 *   'deviceId': defineEntry(type('string | null'), null),
 * };
 * ```
 */
export function defineEntry<TSchema extends StandardSchemaV1>(
	schema: TSchema,
	defaultValue: NoInfer<StandardSchemaV1.InferOutput<TSchema>>,
) {
	return { schema, defaultValue };
}

// ── createPersistedMap ───────────────────────────────────────────────────────

/**
 * Create a reactive persisted map backed by Web Storage with per-key schema validation.
 *
 * Uses `SvelteMap` for fine-grained per-key reactivity. Reading one key
 * doesn't trigger re-renders for components reading another key.
 * Shares a single `storage` event listener and a single `focus` listener
 * for all keys, regardless of how many definitions exist.
 *
 * **Singleton assumption:** Event listeners (`storage`, `focus`) are never removed.
 * Call once at module scope, not inside components or reactive blocks.
 *
 * @example
 * ```ts
 * import { createPersistedMap, defineEntry } from '@epicenter/svelte';
 * import { type } from 'arktype';
 *
 * const config = createPersistedMap({
 *   prefix: 'myapp.config.',
 *   definitions: {
 *     'theme': defineEntry(type("'light' | 'dark'"), 'dark'),
 *     'fontSize': defineEntry(type('number'), 14),
 *   },
 * });
 *
 * config.get('theme');           // 'dark'
 * config.set('theme', 'light');  // persists
 * config.getDefault('fontSize'); // 14
 * config.reset();                // all keys → defaults
 * ```
 */
export function createPersistedMap<
	TDefs extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
>({ prefix, definitions, onError, onUpdateError }: PersistedMapOptions<TDefs>) {
	// Object.keys() returns string[] by design; safe here because we define the object ourselves.
	const definitionKeys = Object.keys(definitions) as (string & keyof TDefs)[];

	function storageKey(key: string) {
		return `${prefix}${key}`;
	}

	function isDefinitionKey(key: string): key is string & keyof TDefs {
		return key in definitions;
	}

	function parseRawValue(key: string & keyof TDefs, raw: string | null) {
		// All `as InferDefinitionValue<...>` casts in this function exist because TS cannot prove
		// that `definitions[key].defaultValue` or `result.value` matches the return type. The
		// inference chain crosses a `NoInfer` wrapper and conditional type extraction that TS
		// can't resolve when `key` is a union (`string & keyof TDefs`). Structurally correct: we
		// control the data flow from schema → validate → return.
		// `!`: key is constrained to `keyof TDefs`, so the lookup always exists.
		const def = definitions[key]!;
		if (raw === null)
			return def.defaultValue as InferDefinitionValue<TDefs[typeof key]>;

		const { data: parsed, error: jsonError } = trySync({
			try: () => JSON.parse(raw) as unknown,
			catch: (cause) => PersistedError.JsonParseFailed({ key, raw, cause }),
		});
		if (jsonError) {
			onError?.(key, jsonError);
			return def.defaultValue as InferDefinitionValue<TDefs[typeof key]>;
		}

		const result = def.schema['~standard'].validate(parsed);
		if (result instanceof Promise) {
			onError?.(
				key,
				PersistedError.SchemaValidationFailed({
					key,
					value: parsed,
					issues: [
						{
							message:
								'Schema returned async result during synchronous validation',
						},
					],
				}).error,
			);
			return def.defaultValue as InferDefinitionValue<TDefs[typeof key]>;
		}

		if (result.issues) {
			onError?.(
				key,
				PersistedError.SchemaValidationFailed({
					key,
					value: parsed,
					issues: result.issues,
				}).error,
			);
			return def.defaultValue as InferDefinitionValue<TDefs[typeof key]>;
		}

		return result.value as InferDefinitionValue<TDefs[typeof key]>;
	}

	function readKey(key: string & keyof TDefs) {
		return parseRawValue(key, window.localStorage.getItem(storageKey(key)));
	}

	// Typed as `unknown` because a single map holds heterogeneous values for all key types.
	// Per-key type safety is recovered via the cast in get().
	const map = new SvelteMap<string, unknown>();
	for (const key of definitionKeys) {
		map.set(key, readKey(key));
	}

	// Cross-tab sync: ONE listener for all keys, filtered by prefix.
	// Listeners are never removed: this function assumes singleton/module-scope usage.
	// localStorage is hardcoded (not a `storage` option) because this `storage`
	// event is a localStorage-only mechanism; sessionStorage would silently lose
	// cross-tab sync. See createPersistedState for the full rationale.
	window.addEventListener('storage', (e) => {
		if (!e.key?.startsWith(prefix)) return;
		const key = e.key.slice(prefix.length);
		if (!isDefinitionKey(key)) return;
		map.set(key, parseRawValue(key, e.newValue));
	});

	// Same-tab sync: ONE listener for all keys.
	window.addEventListener('focus', () => {
		for (const key of definitionKeys) {
			map.set(key, readKey(key));
		}
	});

	return {
		get<TKey extends string & keyof TDefs>(key: TKey) {
			// SvelteMap values are `unknown` (heterogeneous map); cast recovers the per-key type.
			return map.get(key) as InferDefinitionValue<TDefs[TKey]>;
		},

		set<TKey extends string & keyof TDefs>(
			key: TKey,
			value: InferDefinitionValue<TDefs[TKey]>,
		) {
			try {
				window.localStorage.setItem(storageKey(key), JSON.stringify(value));
			} catch (error) {
				onUpdateError?.(key, error);
			}
			map.set(key, value);
		},

		update(
			updates: Partial<{
				[TKey in string & keyof TDefs]: InferDefinitionValue<TDefs[TKey]>;
			}>,
		) {
			// Object.entries() returns [string, unknown][], losing the key/value type relationship.
			for (const [key, value] of Object.entries(updates)) {
				this.set(
					key as string & keyof TDefs,
					value as InferDefinitionValue<TDefs[string & keyof TDefs]>,
				);
			}
		},

		reset() {
			for (const key of definitionKeys) {
				// `!`: key is from definitionKeys (keyof TDefs), so the lookup always exists.
				this.set(
					key,
					definitions[key]!.defaultValue as InferDefinitionValue<
						TDefs[typeof key]
					>,
				);
			}
		},

		getDefault<TKey extends string & keyof TDefs>(key: TKey) {
			// `!`: key is TKey extends keyof TDefs, so the lookup always exists.
			return definitions[key]!.defaultValue as InferDefinitionValue<
				TDefs[TKey]
			>;
		},
	};
}
