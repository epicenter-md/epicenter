/**
 * @fileoverview Converts ColumnSchema to arktype Type definitions
 *
 * This converter transforms epicenter ColumnSchema definitions into arktype types
 * for runtime validation and schema composition. Unlike raw arktype definitions,
 * this maintains proper TypeScript inference for object methods like .partial() and .merge().
 *
 * **Key Design Decision**: Returns raw arktype definition strings/objects (not Type instances)
 * to enable proper type inference when passed to `type()`. This allows arktype to correctly
 * infer ObjectType with composition methods available.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type Type, type } from 'arktype';
import type { ObjectType } from 'arktype/internal/variants/object.ts';
import type {
	BooleanColumnSchema,
	ColumnSchema,
	DateColumnSchema,
	DateWithTimezoneString,
	IdColumnSchema,
	IntegerColumnSchema,
	JsonColumnSchema,
	RealColumnSchema,
	SelectColumnSchema,
	SerializedRow,
	TableSchema,
	TagsColumnSchema,
	TextColumnSchema,
	YtextColumnSchema,
} from '../../schema';
import { DATE_WITH_TIMEZONE_STRING_REGEX } from '../regex';

/**
 * Maps a ColumnSchema to its corresponding arktype Type
 * Similar to ColumnToDrizzle in drizzle.ts, but for arktype
 *
 * This type mapping ensures proper TypeScript inference when building
 * schema fields, preserving exact key information from TSchema.
 */
export type ColumnSchemaToArktypeType<C extends ColumnSchema> =
	C extends IdColumnSchema
		? Type<string>
		: C extends TextColumnSchema<infer TNullable>
			? TNullable extends true
				? Type<string | null>
				: Type<string>
			: C extends YtextColumnSchema<infer TNullable>
				? TNullable extends true
					? Type<string | null>
					: Type<string>
				: C extends IntegerColumnSchema<infer TNullable>
					? TNullable extends true
						? Type<number | null>
						: Type<number>
					: C extends RealColumnSchema<infer TNullable>
						? TNullable extends true
							? Type<number | null>
							: Type<number>
						: C extends BooleanColumnSchema<infer TNullable>
							? TNullable extends true
								? Type<boolean | null>
								: Type<boolean>
							: C extends DateColumnSchema<infer TNullable>
								? TNullable extends true
									? Type<DateWithTimezoneString | null>
									: Type<DateWithTimezoneString>
								: C extends SelectColumnSchema<infer TOptions, infer TNullable>
									? TNullable extends true
										? Type<TOptions[number] | null>
										: Type<TOptions[number]>
									: C extends TagsColumnSchema<infer TOptions, infer TNullable>
										? TNullable extends true
											? Type<TOptions[number][] | null>
											: Type<TOptions[number][]>
										: C extends JsonColumnSchema<infer TSchema, infer TNullable>
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
 * const validator = tableSchemaToArktypeType(schema);
 *
 * // Use immediately for validation
 * const result = validator({ id: '123', title: 'Test', count: 42 });
 *
 * // Or compose with other operations
 * const partialValidator = validator.partial().merge({ id: type.string });
 * const arrayValidator = validator.array();
 * ```
 */
export function tableSchemaToArktypeType<TSchema extends TableSchema>(
	tableSchema: TSchema,
): ObjectType<SerializedRow<TSchema>> {
	return type(
		Object.fromEntries(
			Object.entries(tableSchema).map(([fieldName, columnSchema]) => [
				fieldName,
				columnSchemaToArktypeType(columnSchema),
			]),
		),
	) as ObjectType<SerializedRow<TSchema>>;
}

/**
 * Converts a single ColumnSchema to an arktype Type for runtime validation.
 *
 * Each column type maps to its corresponding arktype validator:
 * - `id`, `text`, `ytext` → `type.string`
 * - `integer` → `type.number.divisibleBy(1)`
 * - `real` → `type.number`
 * - `boolean` → `type.boolean`
 * - `date` → `type.string.matching(DATE_WITH_TIMEZONE_STRING_REGEX)`
 * - `select` → `type.enumerated(...options)`
 * - `multi-select` → `type.enumerated(...options).array()`
 * - `json` → uses the schema's arktype definition directly
 *
 * For nullable columns, wraps with `.or(type.null).default(null)` so that
 * missing fields are automatically defaulted to `null` during validation.
 *
 * @param columnSchema - The column schema to convert
 * @returns arktype Type suitable for validation and composition
 */
function columnSchemaToArktypeType<C extends ColumnSchema>(
	columnSchema: C,
): ColumnSchemaToArktypeType<C> {
	let baseType: Type;

	switch (columnSchema.type) {
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
			baseType = type.enumerated(...columnSchema.options);
			break;
		case 'multi-select':
			// If options provided, validate against them; otherwise allow any string array
			baseType = columnSchema.options
				? type.enumerated(...columnSchema.options).array()
				: type.string.array();
			break;
		case 'json':
			// Use the schema directly from the column definition
			baseType = columnSchema.schema;
			break;
	}

	// Nullable columns: allow null values AND default missing fields to null
	// This enables serialize to strip nulls while deserialize restores them
	return (
		columnSchema.nullable ? baseType.or(type.null).default(null) : baseType
	) as ColumnSchemaToArktypeType<C>;
}
