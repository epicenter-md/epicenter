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
 * mutation-safety story; the cost is six characters at scalar call sites
 * (`() => true` vs `true`), and the win includes dynamic defaults
 * (`() => Date.now()`).
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
 * const startedAt = defineKv(Type.Number(), () => Date.now());
 * ```
 */

import type { Static, TSchema } from 'typebox';
import type { KvDefinition } from './kv';

/**
 * Create a KV definition with a TypeBox schema and a factory default.
 *
 * `defaultValue` runs on every missing-key / validation-failure read, so
 * each call produces a fresh value. Callers may mutate the result of
 * `kv.get()` without affecting other readers.
 */
export function defineKv<S extends TSchema>(
	schema: S,
	defaultValue: () => Static<S>,
): KvDefinition<S> {
	return { schema, defaultValue };
}
