import type { JsonSchema } from 'arktype';
import type { Argv } from 'yargs';
import type { StandardJSONSchemaV1 } from '../core/schema';
import { generateJsonSchema } from '../core/schema';

// =============================================================================
// Type Guards for JsonSchema discriminated union
// =============================================================================

/** Check if schema is an object type with properties */
function isObjectSchema(
	schema: JsonSchema,
): schema is JsonSchema.Object & { properties: Record<string, JsonSchema> } {
	return (
		'type' in schema &&
		schema.type === 'object' &&
		'properties' in schema &&
		schema.properties !== undefined
	);
}

/** Check if schema has enum values */
function isEnumSchema(schema: JsonSchema): schema is JsonSchema.Enum {
	return 'enum' in schema && schema.enum !== undefined;
}

/** Check if schema is a union (anyOf) */
function isUnionSchema(schema: JsonSchema): schema is JsonSchema.Union {
	return 'anyOf' in schema && schema.anyOf !== undefined;
}

/** Check if schema is a oneOf union */
function isOneOfSchema(schema: JsonSchema): schema is JsonSchema.OneOf {
	return 'oneOf' in schema && schema.oneOf !== undefined;
}

/** Check if schema has a const value */
function isConstSchema(schema: JsonSchema): schema is JsonSchema.Const {
	return 'const' in schema && schema.const !== undefined;
}

/** Check if schema has a type field */
function hasType(schema: JsonSchema): schema is JsonSchema.Constrainable & {
	type: JsonSchema.TypeName | JsonSchema.TypeName[];
} {
	return 'type' in schema && schema.type !== undefined;
}

// =============================================================================
// Main conversion function
// =============================================================================

/**
 * Convert a Standard JSON Schema to yargs CLI options
 *
 * This function converts Standard JSON Schema (used by ArkType, Zod, Valibot, etc.)
 * to yargs CLI options by first converting to JSON Schema, then introspecting
 * the JSON Schema structure.
 *
 * @param schema - Standard JSON Schema V1 instance
 * @param yargs - Yargs instance to add options to
 * @returns Modified yargs instance with options added
 *
 * @example
 * ```typescript
 * import { type } from 'arktype';
 * import yargs from 'yargs';
 * import { standardJsonSchemaToYargs } from './standard-json-schema-to-yargs';
 *
 * const schema = type({
 *   name: "string",
 *   age: "number",
 *   active: "boolean?"
 * });
 *
 * const cli = standardJsonSchemaToYargs(schema, yargs);
 * ```
 */
export function standardJsonSchemaToYargs(
	schema: StandardJSONSchemaV1 | undefined,
	yargs: Argv,
): Argv {
	if (!schema) return yargs;

	const jsonSchema = generateJsonSchema(schema);

	if (!isObjectSchema(jsonSchema)) return yargs;

	const required = new Set(jsonSchema.required ?? []);

	for (const [key, fieldSchema] of Object.entries(jsonSchema.properties)) {
		addFieldToYargs({
			key,
			fieldSchema,
			isRequired: required.has(key),
			yargs,
		});
	}

	return yargs;
}

// =============================================================================
// Field processing
// =============================================================================

/**
 * Add a single JSON Schema field to yargs as an option
 *
 * Philosophy: Be permissive. If we can't perfectly represent the schema in yargs,
 * still create the CLI option - just be more lenient. Let Standard Schema validation
 * happen when the action actually runs.
 */
function addFieldToYargs({
	key,
	fieldSchema,
	isRequired,
	yargs,
}: {
	key: string;
	fieldSchema: JsonSchema;
	isRequired: boolean;
	yargs: Argv;
}): void {
	// description is available on ALL JsonSchema branches (they all extend Meta)
	const { description } = fieldSchema;

	// Handle explicit enum property
	if (isEnumSchema(fieldSchema)) {
		const choices = fieldSchema.enum.filter(
			(v): v is string | number =>
				typeof v === 'string' || typeof v === 'number',
		);
		if (choices.length > 0) {
			yargs.option(key, {
				type: typeof choices[0] === 'number' ? 'number' : 'string',
				choices,
				description,
				demandOption: isRequired,
			});
			return;
		}
	}

	// Handle union types (anyOf, oneOf)
	if (isUnionSchema(fieldSchema) || isOneOfSchema(fieldSchema)) {
		const variants = isUnionSchema(fieldSchema)
			? fieldSchema.anyOf
			: fieldSchema.oneOf;

		// Check if it's a union of string literals (const values)
		const stringLiterals = variants
			.filter(isConstSchema)
			.map((v) => v.const)
			.filter((c): c is string => typeof c === 'string');

		if (
			stringLiterals.length === variants.length &&
			stringLiterals.length > 0
		) {
			yargs.option(key, {
				type: 'string',
				choices: stringLiterals,
				description,
				demandOption: isRequired,
			});
			return;
		}

		// For any other union (string | number, string | null, etc),
		// just accept any value - let Standard Schema validate at runtime
		yargs.option(key, {
			description: description ?? 'Union type (validation at runtime)',
			demandOption: isRequired,
		});
		return;
	}

	// Handle standard types
	if (hasType(fieldSchema)) {
		const primaryType = Array.isArray(fieldSchema.type)
			? fieldSchema.type[0]
			: fieldSchema.type;

		if (primaryType) {
			addFieldByType({
				key,
				type: primaryType,
				description,
				isRequired,
				yargs,
			});
			return;
		}
	}

	// Ultimate fallback: no type info, but still create the option
	// Accept any value and let Standard Schema validate when action runs
	yargs.option(key, {
		description: description ?? 'Any value (validation at runtime)',
		demandOption: isRequired,
	});
}

/**
 * Add a field to yargs based on JSON Schema type
 *
 * Even for complex types like objects, we still create CLI options.
 * For unsupported types, we accept them as strings and rely on
 * Standard Schema validation at runtime.
 */
function addFieldByType({
	key,
	type,
	description,
	isRequired,
	yargs,
}: {
	key: string;
	type: JsonSchema.TypeName;
	description: string | undefined;
	isRequired: boolean;
	yargs: Argv;
}): void {
	switch (type) {
		case 'string':
			yargs.option(key, {
				type: 'string',
				description,
				demandOption: isRequired,
			});
			break;

		case 'number':
		case 'integer':
			yargs.option(key, {
				type: 'number',
				description,
				demandOption: isRequired,
			});
			break;

		case 'boolean':
			yargs.option(key, {
				type: 'boolean',
				description,
				demandOption: isRequired,
			});
			break;

		case 'array':
			yargs.option(key, {
				type: 'array',
				description,
				demandOption: isRequired,
			});
			break;

		default:
			// For complex types (object, null), omit 'type' - yargs accepts any value
			// Validation happens via Standard Schema at runtime
			yargs.option(key, {
				description: description ?? `${type} type (validation at runtime)`,
				demandOption: isRequired,
			});
			break;
	}
}
