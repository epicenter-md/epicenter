import type { JsonSchema } from 'arktype';

/**
 * Context passed to arktype's unit fallback handler.
 *
 * @see https://arktype.io/docs/toJson - arktype's toJsonSchema docs
 */
type UnitContext = {
	code: 'unit';
	/** The literal value that can't be represented (undefined, symbol, object, bigint) */
	unit: unknown;
	/** The partial JSON Schema generated so far for this node */
	base: JsonSchema;
};

/**
 * Context passed to arktype's default (catch-all) fallback handler.
 * The `code` field indicates which type of conversion issue occurred.
 *
 * Possible codes: arrayObject, arrayPostfix, defaultValue, domain, morph,
 * patternIntersection, predicate, proto, symbolKey, unit, date
 */
type FallbackContext = {
	code: string;
	base: JsonSchema;
};

/**
 * Arktype fallback handlers for JSON Schema conversion.
 *
 * These handlers intercept conversion issues per-node in the schema tree, allowing
 * partial success. If a schema has 10 fields and only 1 has an unconvertible type,
 * the other 9 are preserved.
 *
 * ## The `undefined` problem
 *
 * Arktype represents optional properties as `T | undefined` internally.
 * JSON Schema doesn't have an `undefined` type; it handles optionality via
 * the `required` array. The `unit` handler strips `undefined` from unions
 * so the conversion succeeds.
 *
 * ## Logging
 *
 * Non-undefined fallbacks are logged with console.warn so you can trace and
 * update schemas that have unconvertible types.
 *
 * @see https://arktype.io/docs/toJson - arktype's toJsonSchema docs
 */
export const ARKTYPE_JSON_SCHEMA_FALLBACK = {
	/**
	 * Handle "unit" types (literal values) that can't be represented in JSON Schema.
	 * - `undefined` is silently stripped (expected for optional properties)
	 * - Other units (null, symbols, objects) are logged and use the base schema
	 */
	unit: (ctx: UnitContext): JsonSchema => {
		if (ctx.unit === undefined) {
			// Return empty schema `{}` to remove undefined from the union.
			// Example: `string | undefined` becomes just `string` in the output.
			// The property's optionality is preserved via JSON Schema's `required` array.
			// Note: This is expected for .partial() schemas (update mutations) - no log needed.
			return {};
		}
		// Log non-undefined unit types so we can trace and fix schemas
		console.warn(
			`[arktype→JSON Schema] Unit type "${String(ctx.unit)}" (${typeof ctx.unit}) cannot be converted. ` +
				`Using base schema as fallback. Consider updating the schema to avoid this type.`,
		);
		return ctx.base;
	},

	/**
	 * Catch-all for any other incompatible arktype features.
	 * Logs the issue with the fallback code and preserves the partial schema.
	 */
	default: (ctx: FallbackContext): JsonSchema => {
		console.warn(
			`[arktype→JSON Schema] Fallback triggered for code "${ctx.code}". ` +
				`Base schema: ${JSON.stringify(ctx.base)}`,
		);
		return ctx.base;
	},
};
