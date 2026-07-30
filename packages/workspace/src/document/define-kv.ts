/**
 * `defineKv(schema, defaultValue)`: TypeBox-native KV definition.
 *
 * KV stores use validate-or-default semantics: invalid or missing values
 * return the result of the `defaultValue` factory. There is no migration
 * step; preferences resetting to the default is acceptable in the contexts
 * KV is used in.
 *
 * `defaultValue` is **always a factory** `() => Static<S>`. The library
 * calls it on every default-branch firing (missing key or validation
 * failure), so callers can mutate the result of `kv.get(...)` without
 * leaking changes to the next reader. The uniformity is the entire
 * mutation-safety story. Defaults must be pure and deterministic: synchronized
 * absence must mean the same thing on every replica. Timestamps, random ids,
 * and device-derived values become shared only through an explicit write.
 *
 * @example
 * ```ts
 * import { Type } from 'typebox';
 *
 * const sidebar = defineKv(Type.Boolean(), () => false);
 *
 * const layout = defineKv(
 *   Type.Object({
 *     collapsed: Type.Boolean(),
 *     width: Type.Number(),
 *   }),
 *   () => ({ collapsed: false, width: 300 }),
 * );
 *
 * ```
 */

import type { Static, TSchema } from 'typebox';
import type { KvDefinition } from './kv';

const kvDefinitions = new WeakSet<object>();

/**
 * Create a KV definition with a TypeBox schema and a factory default.
 *
 * `defaultValue` runs on every missing-key / validation-failure read, so
 * each call produces a fresh, deterministic value. Callers may mutate the
 * result of `kv.get()` without affecting other readers.
 */
export function defineKv<S extends TSchema>(
	schema: S,
	defaultValue: () => Static<S>,
): KvDefinition<S> {
	let ownedSchema: S;
	try {
		ownedSchema = freezeOwnedJson(JSON.parse(JSON.stringify(schema))) as S;
	} catch (cause) {
		throw new Error('KV schema must be JSON serializable', { cause });
	}
	const definition = Object.freeze({
		schema: ownedSchema,
		defaultValue,
	}) as KvDefinition<S>;
	kvDefinitions.add(definition);
	return definition;
}

/** @internal Runtime provenance check for definition consumers. */
export function isKvDefinition(value: unknown): value is KvDefinition {
	return (
		typeof value === 'object' && value !== null && kvDefinitions.has(value)
	);
}

function freezeOwnedJson<TValue>(value: TValue): TValue {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) freezeOwnedJson(child);
	return Object.freeze(value);
}
