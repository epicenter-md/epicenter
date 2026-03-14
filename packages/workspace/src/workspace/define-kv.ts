/**
 * defineKv() for creating KV definitions with required defaults.
 *
 * KV stores use validate-or-default semantics—no migration step.
 * Invalid stored data falls back to `defaultValue`.
 *
 * Use dot-namespaced keys for logical groupings of scalar values:
 * - `'theme.mode'`: `defineKv(type("'light' | 'dark' | 'system'"), 'light')`
 * - `'theme.fontSize'`: `defineKv(type('number'), 14)`
 *
 * @example
 * ```typescript
 * import { defineKv } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * // Boolean preference
 * const sidebar = defineKv(type('boolean'), false);
 *
 * // Object preference
 * const layout = defineKv(type({ collapsed: 'boolean', width: 'number' }), { collapsed: false, width: 300 });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { JsonValue } from 'wellcrafted/json';
import type { CombinedStandardSchema } from '../shared/standard-schema/types.js';
import type { KvDefinition } from './types.js';

/**
 * Create a KV definition with a schema and required default value.
 *
 * The `defaultValue` serves dual duty: it is returned both when the key has
 * never been set (initial state) and when the stored value fails schema
 * validation (corrupt or outdated data). It is never written to storage—
 * it exists only at read time.
 *
 * Schema output must be JSON-serializable (`JsonValue`).
 *
 * Unlike tables, KV stores have no versioning or migration. See
 * {@link KvDefinition} for the full design rationale.
 *
 * @param schema - Standard Schema validator for this entry's value
 * @param defaultValue - Value returned by `get()` when stored data is missing or invalid
 *
 * @example
 * ```typescript
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }), { collapsed: false, width: 300 });
 * const fontSize = defineKv(type('number'), 14);
 * ```
 */
export function defineKv<TSchema extends CombinedStandardSchema<JsonValue>>(
	schema: TSchema,
	defaultValue: StandardSchemaV1.InferOutput<TSchema>,
): KvDefinition<TSchema> {
	return { schema, defaultValue };
}
