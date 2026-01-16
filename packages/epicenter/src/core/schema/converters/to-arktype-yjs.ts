/**
 * @fileoverview Converts FieldSchema to arktype Type definitions for YJS Row validation
 *
 * This converter transforms epicenter FieldSchema definitions into arktype types
 * that validate YJS Row objects (objects with getter properties returning YJS types).
 *
 * Unlike to-arktype.ts which validates SerializedRow (plain JS types), this validates
 * Row objects where:
 * - ytext fields contain Y.Text instances (not strings)
 * - tags fields contain Y.Array instances (not arrays)
 * - Other types remain unchanged (string, number, boolean, etc.)
 */

import { type Type, type } from 'arktype';
import type { ObjectType } from 'arktype/internal/variants/object.ts';
import * as Y from 'yjs';
import { isNullableFieldSchema } from '../fields/nullability';
import type {
	BooleanFieldSchema,
	DateFieldSchema,
	FieldSchema,
	IdFieldSchema,
	IntegerFieldSchema,
	JsonFieldSchema,
	RealFieldSchema,
	Row,
	SelectFieldSchema,
	TableSchema,
	TagsFieldSchema,
	TextFieldSchema,
	YtextFieldSchema,
} from '../fields/types';
import { DATE_WITH_TIMEZONE_STRING_REGEX } from '../runtime/regex';
import type { StandardSchemaV1 } from '../standard/types';

/**
 * Maps a FieldSchema to its corresponding YJS cell value arktype Type.
 * This validates the actual YJS types present in Row objects.
 */
export type FieldSchemaToYjsArktype<C extends FieldSchema> =
	C extends IdFieldSchema
		? Type<string>
		: C extends TextFieldSchema<infer TNullable>
			? TNullable extends true
				? Type<string | null>
				: Type<string>
			: C extends YtextFieldSchema<infer TNullable>
				? TNullable extends true
					? Type<Y.Text | null>
					: Type<Y.Text>
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
									? Type<string | null>
									: Type<string>
								: C extends SelectFieldSchema<infer TOptions, infer TNullable>
									? TNullable extends true
										? Type<TOptions[number] | null>
										: Type<TOptions[number]>
									: C extends TagsFieldSchema<infer TOptions, infer TNullable>
										? TNullable extends true
											? Type<Y.Array<TOptions[number]> | null>
											: Type<Y.Array<TOptions[number]>>
										: C extends JsonFieldSchema<infer TSchema, infer TNullable>
											? TNullable extends true
												? Type<StandardSchemaV1.InferOutput<TSchema> | null>
												: Type<StandardSchemaV1.InferOutput<TSchema>>
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
export function tableSchemaToYjsArktype<TTableSchema extends TableSchema>(
	tableSchema: TTableSchema,
): ObjectType<Row<TTableSchema>> {
	return type(
		Object.fromEntries(
			Object.entries(tableSchema).map(([fieldName, fieldSchema]) => [
				fieldName,
				fieldSchemaToYjsArktype(fieldSchema),
			]),
		),
	) as ObjectType<Row<TTableSchema>>;
}

/**
 * Converts a single FieldSchema to a YJS cell value arktype Type.
 *
 * Returns arktype Type instances that validate YJS types:
 * - ytext → validates Y.Text instances
 * - tags → validates Y.Array instances
 * - Other types → same as regular validation (string, number, etc.)
 *
 * @param fieldSchema - The field schema to convert
 * @returns Arktype Type that validates the YJS cell value
 */
export function fieldSchemaToYjsArktype<C extends FieldSchema>(
	fieldSchema: C,
): FieldSchemaToYjsArktype<C> {
	let baseType: Type;

	switch (fieldSchema['x-component']) {
		case 'id':
		case 'text':
			baseType = type.string;
			break;
		case 'ytext':
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
			baseType = type.enumerated(...fieldSchema.enum);
			break;
		case 'tags':
			baseType = type.instanceOf(Y.Array);
			break;
		case 'json':
			baseType = fieldSchema.schema as unknown as Type<unknown, {}>;
			break;
	}

	const isNullable = isNullableFieldSchema(fieldSchema);
	return (
		isNullable ? baseType.or(type.null) : baseType
	) as FieldSchemaToYjsArktype<C>;
}
