import type { JsonSchema } from 'arktype';
import { Ok, trySync } from 'wellcrafted/result';
import { ARKTYPE_JSON_SCHEMA_FALLBACK } from './arktype-fallback';
import type { StandardJSONSchemaV1 } from './types';

/**
 * Safely convert a Standard JSON Schema to JSON Schema with graceful error handling.
 *
 * Uses the Standard JSON Schema interface (`~standard.jsonSchema.input`) which
 * is vendor-agnostic. For arktype, fallback handlers are passed via `libraryOptions`
 * to handle unconvertible types gracefully.
 *
 * ## Two-layer safety net
 *
 * 1. **Fallback handlers (arktype-specific)**: Intercept conversion issues per-node
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
 * @see https://standardschema.dev/json-schema - Standard JSON Schema spec
 * @see https://arktype.io/docs/json-schema - arktype's toJsonSchema docs
 * @see ARKTYPE_JSON_SCHEMA_FALLBACK in arktype-fallback.ts for fallback handlers
 *
 * @param schema - Standard JSON Schema to convert
 * @returns JSON Schema representation, or permissive `{}` on error
 */
export function standardSchemaToJsonSchema(
	schema: StandardJSONSchemaV1,
): JsonSchema {
	const { data } = trySync({
		try: () =>
			schema['~standard'].jsonSchema.input({
				target: 'draft-2020-12',
				// Pass arktype-specific fallback handlers via libraryOptions.
				// Other vendors will ignore this if they don't support it.
				libraryOptions: {
					fallback: ARKTYPE_JSON_SCHEMA_FALLBACK,
				},
			}) as JsonSchema,
		// Last-resort fallback: if the entire conversion throws, return a
		// permissive empty schema `{}` that accepts any input.
		catch: (e) => {
			console.warn(
				'[standardSchemaToJsonSchema] Conversion failure, using permissive fallback:',
				e,
			);
			return Ok({} satisfies JsonSchema);
		},
	});
	return data;
}
