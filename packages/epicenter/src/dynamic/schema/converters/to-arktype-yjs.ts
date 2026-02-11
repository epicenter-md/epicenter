/**
 * Converts Field to arktype Type definitions for YJS Row validation.
 *
 * Unlike to-arktype.ts which validates SerializedRow, this validates Row objects
 * where fields may contain YJS types.
 */

import { jsonSchemaToType } from '@ark/json-schema';
import { type Type, type } from 'arktype';
import type { ObjectType } from 'arktype/internal/variants/object.ts';
import type { Static, TSchema } from 'typebox';
import { isNullableField } from '../fields/helpers';
import { DATE_TIME_STRING_REGEX } from '../fields/regex';
import type {
	BooleanField,
	DateField,
	Field,
	IdField,
	IntegerField,
	JsonField,
	RealField,
	Row,
	SelectField,
	TagsField,
	TextField,
} from '../fields/types';

/**
 * Maps a Field to its corresponding YJS-aware arktype Type.
 *
 * Unlike `FieldToArktype` which validates serialized values, this type
 * validates Row objects that may contain YJS collaborative types. Use this
 * when working with live YJS data.
 *
 * @example
 * ```typescript
 * type TextType = FieldToYjsArktype<{ type: 'text' }>; // Type<string>
 * type TagsType = FieldToYjsArktype<{ type: 'tags', options: ['a', 'b'] }>; // Type<('a' | 'b')[]>
 * ```
 */
export type FieldToYjsArktype<C extends Field> = C extends IdField
	? Type<string>
	: C extends TextField<infer TNullable>
		? TNullable extends true
			? Type<string | null>
			: Type<string>
		: C extends IntegerField<infer TNullable>
			? TNullable extends true
				? Type<number | null>
				: Type<number>
			: C extends RealField<infer TNullable>
				? TNullable extends true
					? Type<number | null>
					: Type<number>
				: C extends BooleanField<infer TNullable>
					? TNullable extends true
						? Type<boolean | null>
						: Type<boolean>
					: C extends DateField<infer TNullable>
						? TNullable extends true
							? Type<string | null>
							: Type<string>
						: C extends SelectField<infer TOptions, infer TNullable>
							? TNullable extends true
								? Type<TOptions[number] | null>
								: Type<TOptions[number]>
							: C extends TagsField<infer TOptions, infer TNullable>
								? TNullable extends true
									? Type<TOptions[number][] | null>
									: Type<TOptions[number][]>
								: C extends JsonField<infer T extends TSchema, infer TNullable>
									? TNullable extends true
										? Type<Static<T> | null>
										: Type<Static<T>>
									: never;

/**
 * Converts a table schema to an arktype Type for YJS Row validation.
 *
 * Use this validator to check that Row objects (built from Y.Maps) contain
 * correctly-typed values. Unlike `tableToArktype`, this is designed
 * for validating live YJS data before returning it to consumers.
 *
 * @param fields - The table schema to convert
 * @returns Complete arktype Type instance that validates Row objects
 *
 * @example
 * ```typescript
 * const schema = {
 *   id: id(),
 *   title: text(),
 *   tags: tags({ options: ['tech', 'blog'] }),
 * };
 *
 * const validator = tableToYjsArktype(schema);
 *
 * // Build Row from Y.Map
 * const row = buildRowFromYRow(yrow, schema);
 *
 * // Validate the Row
 * const result = validator(row);
 * if (result instanceof type.errors) {
 *   console.error('YJS validation failed:', result.summary);
 * }
 * ```
 */
export function tableToYjsArktype<const TFields extends readonly Field[]>(
	fields: TFields,
): ObjectType<Row<TFields>> {
	return type(
		Object.fromEntries(
			fields.map((field) => [field.id, fieldToYjsArktype(field)]),
		),
	) as ObjectType<Row<TFields>>;
}

/**
 * Converts a single Field to a YJS-aware arktype Type.
 *
 * Returns arktype Type instances that validate YJS cell values. Unlike
 * `fieldToArktype`, this validator is designed for Row objects
 * built from Y.Maps where values have already been extracted.
 *
 * @param field - The field definition to convert
 * @returns Arktype Type that validates the YJS cell value
 *
 * @example
 * ```typescript
 * const textValidator = fieldToYjsArktype({ type: 'text' });
 * const tagsValidator = fieldToYjsArktype({
 *   type: 'tags',
 *   options: ['tech', 'blog'],
 * });
 *
 * textValidator('hello'); // 'hello'
 * tagsValidator(['tech']); // ['tech']
 * tagsValidator(['invalid']); // type.errors
 * ```
 */
export function fieldToYjsArktype<C extends Field>(
	field: C,
): FieldToYjsArktype<C> {
	let baseType: Type;

	switch (field.type) {
		case 'id':
		case 'text':
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
				.matching(DATE_TIME_STRING_REGEX);
			break;
		case 'select':
			baseType = type.enumerated(...field.options);
			break;
		case 'tags':
			baseType = field.options
				? type.enumerated(...field.options).array()
				: type.string.array();
			break;
		case 'json':
			// TypeBox schemas ARE JSON Schema - convert to ArkType at runtime.
			// TODO: Remove cast when @ark/json-schema updates to arktype >=2.1.29
			// Type cast needed due to @ark/json-schema using older arktype version (2.1.23 vs 2.1.29).
			// Runtime behavior is correct; only TS types differ.
			baseType = jsonSchemaToType(field.schema) as unknown as Type;
			break;
	}

	const isNullable = isNullableField(field);
	return (
		isNullable ? baseType.or(type.null) : baseType
	) as FieldToYjsArktype<C>;
}
