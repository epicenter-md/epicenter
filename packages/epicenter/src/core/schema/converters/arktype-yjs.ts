/**
 * @fileoverview Converts ColumnSchema to arktype Type definitions for YJS Row validation
 *
 * This converter transforms epicenter ColumnSchema definitions into arktype types
 * that validate YJS Row objects (objects with getter properties returning YJS types).
 *
 * Unlike arktype.ts which validates SerializedRow (plain JS types), this validates
 * Row objects where:
 * - ytext columns contain Y.Text instances (not strings)
 * - multi-select columns contain Y.Array instances (not arrays)
 * - Other types remain unchanged (string, number, boolean, etc.)
 */

import { type Type, type } from 'arktype';
import type { ObjectType } from 'arktype/internal/variants/object.ts';
import * as Y from 'yjs';
import type {
	BooleanColumnSchema,
	ColumnSchema,
	DateColumnSchema,
	IdColumnSchema,
	IntegerColumnSchema,
	JsonColumnSchema,
	RealColumnSchema,
	Row,
	SelectColumnSchema,
	TableSchema,
	TagsColumnSchema,
	TextColumnSchema,
	YtextColumnSchema,
} from '../../schema';
import { DATE_WITH_TIMEZONE_STRING_REGEX } from '../regex';

/**
 * Maps a ColumnSchema to its corresponding YJS cell value arktype Type.
 * This validates the actual YJS types present in Row objects.
 */
export type ColumnSchemaToYjsArktypeType<C extends ColumnSchema> =
	C extends IdColumnSchema
		? Type<string>
		: C extends TextColumnSchema<infer TNullable>
			? TNullable extends true
				? Type<string | null>
				: Type<string>
			: C extends YtextColumnSchema<infer TNullable>
				? TNullable extends true
					? Type<Y.Text | null>
					: Type<Y.Text>
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
									? Type<string | null>
									: Type<string>
								: C extends SelectColumnSchema<infer TOptions, infer TNullable>
									? TNullable extends true
										? Type<TOptions[number] | null>
										: Type<TOptions[number]>
									: C extends TagsColumnSchema<infer TOptions, infer TNullable>
										? TNullable extends true
											? Type<Y.Array<TOptions[number]> | null>
											: Type<Y.Array<TOptions[number]>>
										: C extends JsonColumnSchema<infer TSchema, infer TNullable>
											? TNullable extends true
												? Type<TSchema['infer'] | null>
												: Type<TSchema['infer']>
											: never;

/**
 * Converts a TableSchema to a fully instantiated arktype Type for YJS Row validation.
 *
 * This validator checks that Row objects (with getter properties) contain the correct
 * YJS types. It validates:
 * - Y.Text instances for ytext columns
 * - Y.Array instances for multi-select columns
 * - Plain JS types for other columns (string, number, boolean, etc.)
 *
 * @param tableSchema - The table schema to convert
 * @returns Complete arktype Type instance that validates Row objects
 *
 * @example
 * ```typescript
 * const schema = {
 *   id: id(),
 *   title: text(),
 *   content: ytext(),
 *   tags: tags(['tech', 'blog'])
 * };
 *
 * const validator = tableSchemaToYjsArktypeType(schema);
 *
 * // Build Row from YRow
 * const row = buildRowFromYRow(yrow, schema);
 *
 * // Validate the Row
 * const result = validator(row);
 * if (result instanceof type.errors) {
 *   console.error('YJS validation failed:', result.summary);
 * } else {
 *   // Row is valid - has Y.Text for content, Y.Array for tags, etc.
 * }
 * ```
 */
export function tableSchemaToYjsArktypeType<TSchema extends TableSchema>(
	tableSchema: TSchema,
): ObjectType<Row<TSchema>> {
	return type(
		Object.fromEntries(
			Object.entries(tableSchema).map(([fieldName, columnSchema]) => [
				fieldName,
				columnSchemaToYjsArktypeType(columnSchema),
			]),
		),
	) as ObjectType<Row<TSchema>>;
}

/**
 * Converts a single ColumnSchema to a YJS cell value arktype Type.
 *
 * Returns arktype Type instances that validate YJS types:
 * - ytext → validates Y.Text instances
 * - multi-select → validates Y.Array instances
 * - Other types → same as regular validation (string, number, etc.)
 *
 * @param columnSchema - The column schema to convert
 * @returns Arktype Type that validates the YJS cell value
 */
function columnSchemaToYjsArktypeType<C extends ColumnSchema>(
	columnSchema: C,
): ColumnSchemaToYjsArktypeType<C> {
	let baseType: Type;

	switch (columnSchema.type) {
		case 'id':
		case 'text':
			baseType = type.string;
			break;
		case 'ytext':
			// Validate Y.Text instances using instanceof check
			baseType = type.instanceOf(Y.Text);
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
			// Validate Y.Array instances using instanceof check
			baseType = type.instanceOf(Y.Array);
			break;
		case 'json':
			// Use the schema directly from the column definition
			baseType = columnSchema.schema;
			break;
	}

	// Handle nullable columns
	return (
		columnSchema.nullable ? baseType.or(type.null) : baseType
	) as ColumnSchemaToYjsArktypeType<C>;
}
