/**
 * @fileoverview Converts FieldSchema to arktype Type definitions
 *
 * This converter transforms epicenter FieldSchema definitions into arktype types
 * for runtime validation and schema composition. Unlike raw arktype definitions,
 * this maintains proper TypeScript inference for object methods like .partial() and .merge().
 *
 * **Key Design Decision**: Returns raw arktype definition strings/objects (not Type instances)
 * to enable proper type inference when passed to `type()`. This allows arktype to correctly
 * infer ObjectType with composition methods available.
 */

import { type Type, type } from 'arktype';
import type { ObjectType } from 'arktype/internal/variants/object.ts';
import { isNullableFieldSchema } from '../fields/nullability';
import type {
	BooleanFieldSchema,
	DateFieldSchema,
	FieldSchema,
	IdFieldSchema,
	IntegerFieldSchema,
	JsonFieldSchema,
	RealFieldSchema,
	SelectFieldSchema,
	SerializedRow,
	TableSchema,
	TagsFieldSchema,
	TextFieldSchema,
	YtextFieldSchema,
} from '../fields/types';
import type { DateWithTimezoneString } from '../runtime/date-with-timezone';
import { DATE_WITH_TIMEZONE_STRING_REGEX } from '../runtime/regex';
import type { StandardSchemaV1 } from '../standard/types';

/**
 * Maps a FieldSchema to its corresponding arktype Type.
 * Similar to FieldToDrizzle in drizzle.ts, but for arktype.
 *
 * This type mapping ensures proper TypeScript inference when building
 * schema fields, preserving exact key information from TSchema.
 */
export type FieldSchemaToArktype<C extends FieldSchema> =
	C extends IdFieldSchema
		? Type<string>
		: C extends TextFieldSchema<infer TNullable>
			? TNullable extends true
				? Type<string | null>
				: Type<string>
			: C extends YtextFieldSchema<infer TNullable>
				? TNullable extends true
					? Type<string | null>
					: Type<string>
				: C extends IntegerFieldSchema<infer TNullable>
					? TNullable extends true
						? Type<number | null>
						: Type<number>
					: C extends RealFieldSchema<infer TNullable>
						? TNullable extends true
							? Type<number | null>
							: Type<number>
						: C extends BooleanFieldSchema<infer TNullable>
							? TNullable extends true
								? Type<boolean | null>
								: Type<boolean>
							: C extends DateFieldSchema<infer TNullable>
								? TNullable extends true
									? Type<DateWithTimezoneString | null>
									: Type<DateWithTimezoneString>
								: C extends SelectFieldSchema<infer TOptions, infer TNullable>
									? TNullable extends true
										? Type<TOptions[number] | null>
										: Type<TOptions[number]>
									: C extends TagsFieldSchema<infer TOptions, infer TNullable>
										? TNullable extends true
											? Type<TOptions[number][] | null>
											: Type<TOptions[number][]>
										: C extends JsonFieldSchema<infer TSchema, infer TNullable>
											? TNullable extends true
												? Type<StandardSchemaV1.InferOutput<TSchema> | null>
												: Type<StandardSchemaV1.InferOutput<TSchema>>
											: never;

/**
 * Converts a TableSchema to a fully instantiated arktype Type.
 *
 * Returns a ready-to-use arktype Type instance with all composition methods available
 * (.partial(), .merge(), .array(), etc.).
 *
 * @param tableSchema - The table schema to convert
 * @returns Complete arktype Type instance with composition methods
 *
 * @example
 * ```typescript
 * const schema = {
 *   id: id(),
 *   title: text(),
 *   count: integer({ nullable: true })
 * };
 *
 * const validator = tableSchemaToArktype(schema);
 *
 * // Use immediately for validation
 * const result = validator({ id: '123', title: 'Test', count: 42 });
 *
 * // Or compose with other operations
 * const partialValidator = validator.partial().merge({ id: type.string });
 * const arrayValidator = validator.array();
 * ```
 */
export function tableSchemaToArktype<TTableSchema extends TableSchema>(
	tableSchema: TTableSchema,
): ObjectType<SerializedRow<TTableSchema>> {
	return type(
		Object.fromEntries(
			Object.entries(tableSchema).map(([fieldName, fieldSchema]) => [
				fieldName,
				fieldSchemaToArktype(fieldSchema),
			]),
		),
	) as ObjectType<SerializedRow<TTableSchema>>;
}

/**
 * Converts a single FieldSchema to an arktype Type for runtime validation.
 *
 * Each field type maps to its corresponding arktype validator:
 * - `id`, `text`, `ytext` → `type.string`
 * - `integer` → `type.number.divisibleBy(1)`
 * - `real` → `type.number`
 * - `boolean` → `type.boolean`
 * - `date` → `type.string.matching(DATE_WITH_TIMEZONE_STRING_REGEX)`
 * - `select` → `type.enumerated(...options)`
 * - `tags` → `type.enumerated(...options).array()`
 * - `json` → uses the schema's arktype definition directly
 *
 * For nullable fields, wraps with `.or(type.null).default(null)` so that
 * missing fields are automatically defaulted to `null` during validation.
 *
 * @param fieldSchema - The field schema to convert
 * @returns arktype Type suitable for validation and composition
 */
export function fieldSchemaToArktype<C extends FieldSchema>(
	fieldSchema: C,
): FieldSchemaToArktype<C> {
	let baseType: Type;

	switch (fieldSchema['x-component']) {
		case 'id':
		case 'text':
		case 'ytext':
			baseType = type.string;
			break;
		case 'integer':
			baseType = type.number.divisibleBy(1);
			break;
		case 'real':
			baseType = type.number;
			break;
		case 'boolean':
			baseType = type.boolean;
			break;
		case 'date':
			baseType = type.string
				.describe(
					'ISO 8601 date with timezone (e.g., 2024-01-01T20:00:00.000Z|America/New_York)',
				)
				.matching(DATE_WITH_TIMEZONE_STRING_REGEX);
			break;
		case 'select':
			baseType = type.enumerated(...fieldSchema.enum);
			break;
		case 'tags':
			baseType = fieldSchema.items.enum
				? type.enumerated(...fieldSchema.items.enum).array()
				: type.string.array();
			break;
		case 'json':
			baseType = fieldSchema.schema as unknown as Type<unknown, {}>;
			break;
	}

	const isNullable = isNullableFieldSchema(fieldSchema);
	return (
		isNullable ? baseType.or(type.null).default(null) : baseType
	) as FieldSchemaToArktype<C>;
}
