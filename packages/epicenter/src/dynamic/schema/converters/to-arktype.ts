/**
 * Converts Field to arktype Type definitions for runtime validation.
 *
 * Returns raw arktype definitions to enable proper type inference for
 * object methods like .partial() and .merge().
 */

import { jsonSchemaToType } from '@ark/json-schema';
import { type Type, type } from 'arktype';
import type { ObjectType } from 'arktype/internal/variants/object.ts';
import type { Static, TSchema } from 'typebox';
import type { DateTimeString } from '../fields/datetime';
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
 * Maps a Field to its corresponding arktype Type.
 *
 * This type mapping ensures proper TypeScript inference when building
 * schema validators, preserving exact type information from the schema.
 *
 * @example
 * ```typescript
 * type TextType = FieldToArktype<{ type: 'text' }>; // Type<string>
 * type NullableInt = FieldToArktype<{ type: 'integer', nullable: true }>; // Type<number | null>
 * ```
 */
export type FieldToArktype<C extends Field> = C extends IdField
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
							? Type<DateTimeString | null>
							: Type<DateTimeString>
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
 * Converts a table schema to a fully instantiated arktype Type.
 *
 * Returns a ready-to-use arktype Type instance with all composition methods
 * available (.partial(), .merge(), .array(), etc.). Use this for validating
 * complete row objects.
 *
 * @param fields - The table schema as a Field[] array
 * @returns Complete arktype Type instance with composition methods
 *
 * @example
 * ```typescript
 * const fields = [
 *   id(),
 *   text({ id: 'title' }),
 *   integer({ id: 'count', nullable: true }),
 * ];
 *
 * const validator = tableToArktype(fields);
 *
 * // Use immediately for validation
 * const result = validator({ id: '123', title: 'Test', count: 42 });
 * if (result instanceof type.errors) {
 *   console.error('Validation failed:', result.summary);
 * }
 *
 * // Or compose with other operations
 * const partialValidator = validator.partial();
 * const arrayValidator = validator.array();
 * ```
 */
export function tableToArktype<const TFields extends readonly Field[]>(
	fields: TFields,
): ObjectType<Row<TFields>> {
	const properties: Record<string, Type> = {};
	for (const field of fields) {
		properties[field.id] = fieldToArktype(field);
	}
	return type(properties) as ObjectType<Row<TFields>>;
}

/**
 * Converts a single Field to an arktype Type for runtime validation.
 *
 * Use this when you need to validate individual field values. For nullable
 * fields, automatically wraps with `.or(type.null).default(null)` so that
 * missing fields are defaulted to `null` during validation.
 *
 * Field type mappings:
 * - `id`, `text` → `type.string`
 * - `integer` → `type.number.divisibleBy(1)`
 * - `real` → `type.number`
 * - `boolean` → `type.boolean`
 * - `date` → `type.string.matching(DATE_TIME_STRING_REGEX)`
 * - `select` → `type.enumerated(...options)`
 * - `tags` → `type.enumerated(...options).array()` or `type.string.array()`
 * - `json` → uses the embedded arktype schema directly
 *
 * @param field - The field definition to convert
 * @returns arktype Type suitable for validation and composition
 *
 * @example
 * ```typescript
 * const textValidator = fieldToArktype({ type: 'text' });
 * const selectValidator = fieldToArktype({
 *   type: 'select',
 *   options: ['draft', 'published'],
 * });
 *
 * textValidator('hello'); // 'hello'
 * selectValidator('draft'); // 'draft'
 * selectValidator('invalid'); // type.errors
 * ```
 */
export function fieldToArktype<C extends Field>(field: C): FieldToArktype<C> {
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
		isNullable ? baseType.or(type.null).default(null) : baseType
	) as FieldToArktype<C>;
}
