/**
 * Converts Field to TypeBox TSchema definitions for runtime validation.
 *
 * TypeBox schemas can be compiled to JIT validators using `Compile()` from `typebox/compile`.
 */

import {
	type TArray,
	type TBoolean,
	type TInteger,
	type TNull,
	type TNumber,
	type TObject,
	type TSchema,
	type TString,
	type TUnion,
	Type,
} from 'typebox';
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
	SelectField,
	TagsField,
	TextField,
} from '../fields/types';

/**
 * Maps a Field to its corresponding TypeBox TSchema type.
 *
 * Use `Static<typeof schema>` to infer the TypeScript type from the returned schema.
 *
 * @example
 * ```typescript
 * const schema = fieldToTypebox({ type: 'text' });
 * type TextValue = Static<typeof schema>; // string
 *
 * const nullableSchema = fieldToTypebox({ type: 'integer', nullable: true });
 * type NullableInt = Static<typeof nullableSchema>; // number | null
 * ```
 */
export type FieldToTypebox<C extends Field> = C extends IdField
	? TString
	: C extends TextField<infer TNullable>
		? TNullable extends true
			? TUnion<[TString, TNull]>
			: TString
		: C extends IntegerField<infer TNullable>
			? TNullable extends true
				? TUnion<[TInteger, TNull]>
				: TInteger
			: C extends RealField<infer TNullable>
				? TNullable extends true
					? TUnion<[TNumber, TNull]>
					: TNumber
				: C extends BooleanField<infer TNullable>
					? TNullable extends true
						? TUnion<[TBoolean, TNull]>
						: TBoolean
					: C extends DateField<infer TNullable>
						? TNullable extends true
							? TUnion<[TString, TNull]>
							: TString
						: C extends SelectField<infer _TOptions, infer TNullable>
							? TNullable extends true
								? TUnion<TSchema[]>
								: TUnion<TSchema[]>
							: C extends TagsField<infer _TOptions, infer TNullable>
								? TNullable extends true
									? TUnion<[TArray, TNull]>
									: TArray
								: C extends JsonField<infer _TStandardSchema, infer TNullable>
									? TNullable extends true
										? TUnion<[TSchema, TNull]>
										: TSchema
									: never;

/**
 * Converts a table schema to a TypeBox TObject schema.
 *
 * Use this when you need to validate entire row objects. The resulting schema
 * can be compiled to a JIT validator for high-performance validation.
 *
 * @param fields - Array of field definitions (each field has an `id` property)
 * @returns A TypeBox TObject schema representing the table structure
 *
 * @example
 * ```typescript
 * import { Compile } from 'typebox/compile';
 *
 * const fields = [
 *   id(),
 *   text({ id: 'title' }),
 *   integer({ id: 'count', nullable: true }),
 * ];
 *
 * const typeboxSchema = fieldsToTypebox(fields);
 * const validator = Compile(typeboxSchema);
 *
 * validator.Check({ id: '123', title: 'Test', count: 42 }); // true
 * validator.Check({ id: '123', title: 'Test', count: null }); // true (nullable)
 * validator.Check({ id: '123', title: 'Test' }); // false (missing count)
 * ```
 */
export function fieldsToTypebox<const TFields extends readonly Field[]>(
	fields: TFields,
): TObject {
	const properties: Record<string, TSchema> = {};

	for (const field of fields) {
		properties[field.id] = fieldToTypebox(field);
	}

	return Type.Object(properties);
}

/**
 * Converts a single Field to a TypeBox TSchema.
 *
 * Use this when you need to validate individual field values rather than
 * complete row objects. The resulting schema is JIT-compilable.
 *
 * Field type mappings:
 * - `id`, `text` → `Type.String()`
 * - `integer` → `Type.Integer()`
 * - `real` → `Type.Number()`
 * - `boolean` → `Type.Boolean()`
 * - `date` → `Type.String({ pattern })` with DateTimeString regex
 * - `select` → `Type.Union([Type.Literal(...), ...])`
 * - `tags` → `Type.Array(...)` with uniqueItems constraint
 * - `json` → JSON Schema from embedded StandardSchema (fully JIT-compiled)
 *
 * @param field - The field definition to convert
 * @returns A TypeBox TSchema suitable for validation
 *
 * @example
 * ```typescript
 * const textSchema = fieldToTypebox({ type: 'text' });
 * const selectSchema = fieldToTypebox({
 *   type: 'select',
 *   options: ['draft', 'published'],
 * });
 * ```
 */
export function fieldToTypebox<C extends Field>(field: C): FieldToTypebox<C> {
	let baseType: TSchema;

	switch (field.type) {
		case 'id':
		case 'text':
			baseType = Type.String();
			break;

		case 'integer':
			baseType = Type.Integer();
			break;

		case 'real':
			baseType = Type.Number();
			break;

		case 'boolean':
			baseType = Type.Boolean();
			break;

		case 'date':
			baseType = Type.String({
				description:
					'ISO 8601 date with timezone (e.g., 2024-01-01T20:00:00.000Z|America/New_York)',
				pattern: DATE_TIME_STRING_REGEX.source,
			});
			break;

		case 'select': {
			const literals = field.options.map((value) => Type.Literal(value));
			baseType = Type.Union(literals);
			break;
		}

		case 'tags': {
			if (field.options) {
				const literals = field.options.map((value) => Type.Literal(value));
				baseType = Type.Array(Type.Union(literals), { uniqueItems: true });
			} else {
				baseType = Type.Array(Type.String(), { uniqueItems: true });
			}
			break;
		}

		case 'json': {
			// TypeBox schemas ARE JSON Schema - use directly
			baseType = field.schema;
			break;
		}
	}

	const isNullable = isNullableField(field);
	if (isNullable) {
		baseType = Type.Union([baseType, Type.Null()]);
	}

	return baseType as FieldToTypebox<C>;
}
