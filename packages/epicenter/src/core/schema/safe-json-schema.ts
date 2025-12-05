import { toJsonSchema } from '@standard-community/standard-json';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { JsonSchema } from 'arktype';
import { Ok, tryAsync } from 'wellcrafted/result';
import { ARKTYPE_JSON_SCHEMA_FALLBACK } from './arktype-fallback';

/**
 * Safely convert a Standard Schema to JSON Schema with graceful error handling.
 *
 * ## Why this wrapper exists
 *
 * standard-json is a vendor-agnostic library that converts any Standard Schema
 * (zod, arktype, valibot, etc.) to JSON Schema. It detects the vendor from
 * `schema["~standard"].vendor` and delegates to the appropriate handler.
 *
 * For arktype specifically, the handler passes options directly to arktype's
 * `Type.toJsonSchema()` method. The options aren't typed in standard-json
 * (they're `Record<string, unknown>`) because each vendor has different options.
 *
 * ## Two-layer safety net
 *
 * 1. **Fallback handlers (arktype API)**: Intercept conversion issues per-node
 *    in the schema tree, allowing partial success. If a schema has 10 fields
 *    and only 1 has an unconvertible type, the other 9 are preserved.
 *
 * 2. **Outer catch**: Last-resort failsafe for truly catastrophic failures.
 *    Returns `{}` (permissive empty schema) if everything else fails.
 *
 * ## The `undefined` problem
 *
 * Arktype represents optional properties as `T | undefined` internally.
 * JSON Schema doesn't have an `undefined` type; it handles optionality via
 * the `required` array. The `unit` fallback handler strips `undefined` from
 * unions so the conversion succeeds.
 *
 * @see https://github.com/standard-community/standard-json - standard-json repo
 * @see https://arktype.io/docs/json-schema - arktype's toJsonSchema docs
 * @see ARKTYPE_JSON_SCHEMA_FALLBACK in ./arktype-fallback.ts for fallback handlers
 *
 * @param schema - Standard Schema to convert
 * @returns JSON Schema representation, or permissive `{}` on catastrophic error
 */
export async function safeToJsonSchema(
	schema: StandardSchemaV1,
): Promise<JsonSchema> {
	const { data } = await tryAsync({
		try: async () =>
			// The second argument is passed through to arktype's toJsonSchema().
			// Types are loose (Record<string, unknown>) because standard-json is
			// vendor-agnostic. These options are arktype-specific.
			// See: https://arktype.io/docs/json-schema#fallback
			await toJsonSchema(schema, {
				fallback: ARKTYPE_JSON_SCHEMA_FALLBACK,
			}),
		// Last-resort fallback: if the entire conversion throws (shouldn't happen
		// with the fallback handlers above, but defensive coding), return a
		// permissive empty schema `{}` that accepts any input.
		catch: (e) => {
			console.warn(
				'[arktype→JSON Schema] Catastrophic conversion failure, using permissive fallback:',
				e,
			);
			return Ok({} satisfies JsonSchema);
		},
	});
	return data;
}
