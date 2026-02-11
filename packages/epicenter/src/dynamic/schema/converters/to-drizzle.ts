import slugify from '@sindresorhus/slugify';
import type { $Type, IsPrimaryKey, NotNull } from 'drizzle-orm';
import {
	integer,
	real,
	type SQLiteBooleanBuilderInitial,
	type SQLiteCustomColumnBuilder,
	type SQLiteIntegerBuilderInitial,
	type SQLiteRealBuilderInitial,
	type SQLiteTable,
	type SQLiteTextBuilderInitial,
	sqliteTable,
	text,
} from 'drizzle-orm/sqlite-core';
import type { Static, TSchema } from 'typebox';
import { date, json, tags } from '../../../extensions/sqlite/builders';
import type { DateTimeString } from '../fields/datetime';
import { isNullableField } from '../fields/helpers';
import type {
	BooleanField,
	DateField,
	Field,
	FieldById,
	IdField,
	IntegerField,
	JsonField,
	RealField,
	SelectField,
	TableDefinition,
	TagsField,
	TextField,
} from '../fields/types';

export function toSqlIdentifier(displayName: string): string {
	return slugify(displayName, { separator: '_' });
}

/**
 * Maps table definitions to their Drizzle table representations.
 *
 * Use this type when you need to reference the return type of
 * `convertTableDefinitionsToDrizzle` in your type definitions.
 */
export type TableDefinitionsToDrizzle<
	TTableDefinitions extends readonly TableDefinition[],
> = {
	[K in TTableDefinitions[number]['id']]: ReturnType<
		typeof convertTableToDrizzle<Extract<TTableDefinitions[number], { id: K }>>
	>;
};

/**
 * Convert table definitions to Drizzle SQLite tables.
 *
 * This is the main entry point for converting table definitions
 * into Drizzle table definitions for database operations.
 *
 * @param definitions - The table definitions array (from `tables.definitions`)
 * @returns A record mapping table names to their Drizzle SQLiteTable representations
 *
 * @example
 * ```typescript
 * // In an extension, use tables.definitions directly
 * const drizzleTables = convertTableDefinitionsToDrizzle(tables.definitions);
 *
 * // Use with Drizzle queries
 * const allUsers = await db.select().from(drizzleTables.users);
 * ```
 */
export function convertTableDefinitionsToDrizzle<
	TTableDefinitions extends readonly TableDefinition[],
>(
	definitions: TTableDefinitions,
): TableDefinitionsToDrizzle<TTableDefinitions> {
	const result: Record<string, SQLiteTable> = {};

	for (const tableDefinition of definitions) {
		result[tableDefinition.id] = convertTableToDrizzle(tableDefinition);
	}

	return result as TableDefinitionsToDrizzle<TTableDefinitions>;
}

/** Convert a single table schema to a Drizzle SQLiteTable. */
function convertTableToDrizzle<TTableDef extends TableDefinition>(
	tableDefinition: TTableDef,
) {
	const columns = Object.fromEntries(
		tableDefinition.fields.map((field) => {
			const sqlColumnName = field.name ? toSqlIdentifier(field.name) : field.id;
			return [field.id, convertFieldToDrizzle(sqlColumnName, field)];
		}),
	) as {
		[K in TTableDef['fields'][number]['id']]: FieldToDrizzle<
			FieldById<TTableDef['fields'], K>
		>;
	};

	return sqliteTable(tableDefinition.id, columns);
}

type FieldToDrizzle<C extends Field> = C extends IdField
	? IsPrimaryKey<
			NotNull<SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>>
		>
	: C extends TextField<infer TNullable>
		? TNullable extends true
			? SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>
			: NotNull<SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>>
		: C extends IntegerField<infer TNullable>
			? TNullable extends true
				? SQLiteIntegerBuilderInitial<''>
				: NotNull<SQLiteIntegerBuilderInitial<''>>
			: C extends RealField<infer TNullable>
				? TNullable extends true
					? SQLiteRealBuilderInitial<''>
					: NotNull<SQLiteRealBuilderInitial<''>>
				: C extends BooleanField<infer TNullable>
					? TNullable extends true
						? SQLiteBooleanBuilderInitial<''>
						: NotNull<SQLiteBooleanBuilderInitial<''>>
					: C extends DateField<infer TNullable>
						? TNullable extends true
							? $Type<
									SQLiteTextBuilderInitial<
										'',
										[string, ...string[]],
										undefined
									>,
									DateTimeString
								>
							: NotNull<
									$Type<
										SQLiteTextBuilderInitial<
											'',
											[string, ...string[]],
											undefined
										>,
										DateTimeString
									>
								>
						: C extends SelectField<infer TOptions, infer TNullable>
							? TNullable extends true
								? SQLiteTextBuilderInitial<
										'',
										[...TOptions],
										number | undefined
									>
								: NotNull<
										SQLiteTextBuilderInitial<
											'',
											[...TOptions],
											number | undefined
										>
									>
							: C extends TagsField<infer TOptions, infer TNullable>
								? TNullable extends true
									? SQLiteCustomColumnBuilder<{
											name: '';
											dataType: 'custom';
											columnType: 'SQLiteCustomColumn';
											data: TOptions[number][];
											driverParam: string;
											enumValues: undefined;
										}>
									: NotNull<
											SQLiteCustomColumnBuilder<{
												name: '';
												dataType: 'custom';
												columnType: 'SQLiteCustomColumn';
												data: TOptions[number][];
												driverParam: string;
												enumValues: undefined;
											}>
										>
								: C extends JsonField<infer T extends TSchema, infer TNullable>
									? TNullable extends true
										? SQLiteCustomColumnBuilder<{
												name: '';
												dataType: 'custom';
												columnType: 'SQLiteCustomColumn';
												data: Static<T>;
												driverParam: string;
												enumValues: undefined;
											}>
										: NotNull<
												SQLiteCustomColumnBuilder<{
													name: '';
													dataType: 'custom';
													columnType: 'SQLiteCustomColumn';
													data: Static<T>;
													driverParam: string;
													enumValues: undefined;
												}>
											>
									: never;

function convertFieldToDrizzle<C extends Field>(
	columnName: string,
	field: C,
): FieldToDrizzle<C> {
	const isNullable = isNullableField(field);

	switch (field.type) {
		case 'id':
			return text(columnName).primaryKey().notNull() as FieldToDrizzle<C>;

		case 'text': {
			let column = text(columnName);
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'integer': {
			let column = integer(columnName);
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'real': {
			let column = real(columnName);
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'boolean': {
			let column = integer(columnName, { mode: 'boolean' });
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'date': {
			const column = date({
				nullable: isNullable,
				default: field.default,
			});
			return column as unknown as FieldToDrizzle<C>;
		}

		case 'select': {
			let column = text(columnName, { enum: [...field.options] });
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'tags': {
			const column = tags({
				options: field.options,
				nullable: isNullable,
				default: field.default,
			});
			return column as FieldToDrizzle<C>;
		}

		case 'json': {
			const column = json({
				schema: field.schema,
				nullable: isNullable,
				default: field.default,
			});
			return column as FieldToDrizzle<C>;
		}

		default:
			throw new Error(`Unknown field type: ${(field as Field).type}`);
	}
}
