import Type, { type TSchema } from 'typebox';
import type { Options } from 'yargs';

type YargsType = 'string' | 'number' | 'boolean' | 'array' | 'count';

/**
 * TypeBox's TSchema is an empty interface {}, but at runtime factory functions
 * merge TSchemaOptions (description, default, etc.) onto the schema object.
 * This type declares only the properties we actually read during conversion.
 */
type FieldSchema = TSchema & {
	type?: string;
	description?: string;
	default?: unknown;
};

/**
 * Convert a TypeBox object schema to a yargs options record.
 *
 * Takes a TypeBox `Type.Object(...)` schema and returns a record of yargs option
 * configurations. Uses a permissive approach: if a schema type can't be cleanly
 * mapped to yargs, the option is still created without a type constraint, letting
 * action validation handle strict checking.
 *
 * @example
 * ```typescript
 * const schema = Type.Object({ title: Type.String(), count: Type.Optional(Type.Number()) });
 * const options = typeboxToYargsOptions(schema);
 * // { title: { type: 'string', demandOption: true }, count: { type: 'number', demandOption: false } }
 * ```
 */
export function typeboxToYargsOptions(
	schema: TSchema,
): Record<string, Options> {
	if (!Type.IsObject(schema)) return {};

	const required = new Set(schema.required ?? []);
	const options: Record<string, Options> = {};

	for (const [key, fieldSchema] of Object.entries(schema.properties)) {
		options[key] = fieldToYargsOption(
			fieldSchema as FieldSchema,
			required.has(key),
		);
	}

	return options;
}

function fieldToYargsOption(schema: FieldSchema, isRequired: boolean): Options {
	const option: Options = {
		description: schema.description,
		demandOption: isRequired,
		default: schema.default,
	};

	const choices = extractChoices(schema);
	if (choices) {
		option.type = typeof choices[0] === 'number' ? 'number' : 'string';
		option.choices = choices;
		return option;
	}

	const yargsType = schemaTypeToYargsType(schema.type);
	if (yargsType) {
		option.type = yargsType;
	}

	return option;
}

function extractChoices(schema: TSchema): (string | number)[] | undefined {
	if (Type.IsEnum(schema)) {
		const choices = schema.enum.filter(
			(v): v is string | number =>
				typeof v === 'string' || typeof v === 'number',
		);
		return choices.length > 0 ? choices : undefined;
	}

	if (Type.IsLiteral(schema)) {
		const val = schema.const;
		if (typeof val === 'string' || typeof val === 'number') return [val];
	}

	if (Type.IsUnion(schema)) {
		const choices: string[] = [];
		for (const variant of schema.anyOf) {
			if (Type.IsNull(variant)) continue;
			if (Type.IsLiteral(variant) && typeof variant.const === 'string') {
				choices.push(variant.const);
			} else {
				return undefined;
			}
		}
		return choices.length > 0 ? choices : undefined;
	}

	return undefined;
}

function schemaTypeToYargsType(
	type: string | undefined,
): YargsType | undefined {
	switch (type) {
		case 'string':
			return 'string';
		case 'number':
		case 'integer':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'array':
			return 'array';
		default:
			return undefined;
	}
}
