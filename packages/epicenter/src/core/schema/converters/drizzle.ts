import type { IsPrimaryKey, NotNull } from 'drizzle-orm';
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
import { date, json, tags } from '../../../indexes/sqlite/schema/builders';
import type {
	BooleanColumnSchema,
	ColumnSchema,
	DateColumnSchema,
	DateWithTimezone,
	DateWithTimezoneString,
	IdColumnSchema,
	IntegerColumnSchema,
	JsonColumnSchema,
	RealColumnSchema,
	SelectColumnSchema,
	TableSchema,
	TagsColumnSchema,
	TextColumnSchema,
	WorkspaceSchema,
	YtextColumnSchema,
} from '../../schema';

/**
 * Maps a WorkspaceSchema to its Drizzle table representations.
 *
 * This type preserves the table names as keys and maps each TableSchema
 * to its corresponding SQLiteTable type with full column type information.
 *
 * @typeParam TWorkspaceSchema - The workspace schema containing all table definitions
 *
 * @remarks
 * The `& string` intersection is required because TypeScript conservatively types
 * `keyof TWorkspaceSchema` as `string | number | symbol` even though
 * WorkspaceSchema = Record<string, TableSchema>. The intersection narrows
 * the type to satisfy convertTableSchemaToDrizzle's string constraint.
 */
export type WorkspaceSchemaToDrizzleTables<
	TWorkspaceSchema extends WorkspaceSchema,
> = {
	[K in keyof TWorkspaceSchema & string]: ReturnType<
		typeof convertTableSchemaToDrizzle<K, TWorkspaceSchema[K]>
	>;
};

/**
 * Convert a workspace schema to Drizzle SQLite tables.
 *
 * This is the main entry point for converting a complete workspace schema
 * (which may contain multiple tables) into Drizzle table definitions that
 * can be used for database operations.
 *
 * @param schema - The workspace schema containing all table definitions
 * @returns A record mapping table names to their Drizzle SQLiteTable representations
 *
 * @example
 * ```ts
 * const schema = {
 *   users: { id: { type: 'id' }, name: { type: 'text' } },
 *   posts: { id: { type: 'id' }, title: { type: 'text' } },
 * };
 * const tables = convertWorkspaceSchemaToDrizzle(schema);
 * // tables.users and tables.posts are now SQLiteTable instances
 * ```
 */
export function convertWorkspaceSchemaToDrizzle<
	TWorkspaceSchema extends WorkspaceSchema,
>(schema: TWorkspaceSchema): WorkspaceSchemaToDrizzleTables<TWorkspaceSchema> {
	const result: Record<string, SQLiteTable> = {};

	for (const tableName of Object.keys(schema)) {
		const tableSchema = schema[tableName];
		if (!tableSchema) {
			throw new Error(`Table schema for "${tableName}" is undefined`);
		}
		result[tableName] = convertTableSchemaToDrizzle(tableName, tableSchema);
	}

	return result as WorkspaceSchemaToDrizzleTables<TWorkspaceSchema>;
}

/**
 * Convert a single table schema to a Drizzle SQLiteTable.
 *
 * Takes a table name and its column schema definitions, then creates
 * a Drizzle table with all columns properly typed and configured.
 *
 * @param tableName - The name of the table (used in SQL)
 * @param tableSchema - The schema defining all columns for this table
 * @returns A Drizzle SQLiteTable with typed columns
 *
 * @example
 * ```ts
 * const usersTable = convertTableSchemaToDrizzle('users', {
 *   id: { type: 'id' },
 *   name: { type: 'text' },
 *   age: { type: 'integer', nullable: true },
 * });
 * ```
 */
export function convertTableSchemaToDrizzle<
	TTableName extends string,
	TTableSchema extends TableSchema,
>(tableName: TTableName, tableSchema: TTableSchema) {
	const columns = Object.fromEntries(
		Object.keys(tableSchema).map((columnName) => [
			columnName,
			convertColumnSchemaToDrizzle(
				columnName,
				tableSchema[columnName as keyof TTableSchema],
			),
		]),
	) as { [Key in keyof TTableSchema]: ColumnToDrizzle<TTableSchema[Key]> };

	return sqliteTable(tableName, columns);
}

/**
 * Maps a ColumnSchema to its corresponding Drizzle column builder type.
 *
 * This conditional type chain determines the exact Drizzle type for each
 * column schema variant. It handles:
 * - NotNull wrapper when nullable is false
 * - Custom column types for date, tags, and json
 * - Drizzle's built-in types for primitives (text, integer, real, boolean)
 *
 * The type uses nested conditional types to match against each possible
 * column schema type in order: id → text → ytext → integer → real →
 * boolean → date → select → multi-select → json → never
 */
type ColumnToDrizzle<C extends ColumnSchema> = C extends IdColumnSchema
	? IsPrimaryKey<
			NotNull<SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>>
		>
	: C extends TextColumnSchema<infer TNullable>
		? TNullable extends true
			? SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>
			: NotNull<SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>>
		: C extends YtextColumnSchema<infer TNullable>
			? TNullable extends true
				? SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>
				: NotNull<
						SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>
					>
			: C extends IntegerColumnSchema<infer TNullable>
				? TNullable extends true
					? SQLiteIntegerBuilderInitial<''>
					: NotNull<SQLiteIntegerBuilderInitial<''>>
				: C extends RealColumnSchema<infer TNullable>
					? TNullable extends true
						? SQLiteRealBuilderInitial<''>
						: NotNull<SQLiteRealBuilderInitial<''>>
					: C extends BooleanColumnSchema<infer TNullable>
						? TNullable extends true
							? SQLiteBooleanBuilderInitial<''>
							: NotNull<SQLiteBooleanBuilderInitial<''>>
						: C extends DateColumnSchema<infer TNullable>
							? TNullable extends true
								? SQLiteCustomColumnBuilder<{
										name: '';
										dataType: 'custom';
										columnType: 'SQLiteCustomColumn';
										data: DateWithTimezone;
										driverParam: DateWithTimezoneString;
										enumValues: undefined;
									}>
								: NotNull<
										SQLiteCustomColumnBuilder<{
											name: '';
											dataType: 'custom';
											columnType: 'SQLiteCustomColumn';
											data: DateWithTimezone;
											driverParam: DateWithTimezoneString;
											enumValues: undefined;
										}>
									>
							: C extends SelectColumnSchema<infer TOptions, infer TNullable>
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
								: C extends TagsColumnSchema<infer TOptions, infer TNullable>
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
									: C extends JsonColumnSchema<infer TSchema, infer TNullable>
										? TNullable extends true
											? SQLiteCustomColumnBuilder<{
													name: '';
													dataType: 'custom';
													columnType: 'SQLiteCustomColumn';
													data: TSchema['infer'];
													driverParam: string;
													enumValues: undefined;
												}>
											: NotNull<
													SQLiteCustomColumnBuilder<{
														name: '';
														dataType: 'custom';
														columnType: 'SQLiteCustomColumn';
														data: TSchema['infer'];
														driverParam: string;
														enumValues: undefined;
													}>
												>
										: never;

/**
 * Convert a ColumnSchema to a Drizzle column builder.
 *
 * This function uses two distinct patterns depending on column complexity:
 *
 * **Pattern 1: Primitive Types (text, integer, real, boolean, select)**
 * Uses Drizzle's built-in column functions from `drizzle-orm/sqlite-core` and
 * explicitly chains `.notNull()` and `.default()`/`.$defaultFn()` based on schema.
 * This is necessary because Drizzle's primitives require the column name as
 * the first argument and don't accept a schema object.
 *
 * **Pattern 2: Custom Types (date, multi-select, json)**
 * Uses custom builders from `builders.ts` that accept the entire schema object.
 * These builders encapsulate complex serialization logic (timezone handling,
 * JSON array validation, arktype validation) and handle nullable/default internally.
 * The schema object is passed directly because it contains all the configuration
 * the builder needs (nullable, default, options, validation schema, etc.).
 *
 * @example
 * // Pattern 1: Primitive with explicit chaining
 * let column = text(columnName);
 * if (!schema.nullable) column = column.notNull();
 *
 * // Pattern 2: Custom builder with schema object
 * const column = date(schema); // nullable/default handled internally
 */
function convertColumnSchemaToDrizzle<C extends ColumnSchema>(
	columnName: string,
	schema: C,
): ColumnToDrizzle<C> {
	switch (schema.type) {
		case 'id':
			// ID is always a primary key text column with auto-generated nano ID
			return text(columnName).primaryKey().notNull() as ColumnToDrizzle<C>;

		case 'text': {
			// Pattern 1: Use Drizzle's text() and chain modifiers
			let column = text(columnName);
			if (!schema.nullable) column = column.notNull();
			if (schema.default !== undefined) {
				column =
					typeof schema.default === 'function'
						? column.$defaultFn(schema.default)
						: column.default(schema.default);
			}
			return column as ColumnToDrizzle<C>;
		}

		case 'ytext': {
			// Y.Text stored as plain text (lossy conversion via toString())
			// No default support since Y.Text content comes from CRDT
			let column = text(columnName);
			if (!schema.nullable) column = column.notNull();
			return column as ColumnToDrizzle<C>;
		}

		case 'integer': {
			let column = integer(columnName);
			if (!schema.nullable) column = column.notNull();
			if (schema.default !== undefined) {
				column =
					typeof schema.default === 'function'
						? column.$defaultFn(schema.default)
						: column.default(schema.default);
			}
			return column as ColumnToDrizzle<C>;
		}

		case 'real': {
			let column = real(columnName);
			if (!schema.nullable) column = column.notNull();
			if (schema.default !== undefined) {
				column =
					typeof schema.default === 'function'
						? column.$defaultFn(schema.default)
						: column.default(schema.default);
			}
			return column as ColumnToDrizzle<C>;
		}

		case 'boolean': {
			// SQLite has no native boolean; stored as INTEGER (0 or 1)
			let column = integer(columnName, { mode: 'boolean' });
			if (!schema.nullable) column = column.notNull();
			if (schema.default !== undefined) {
				column =
					typeof schema.default === 'function'
						? column.$defaultFn(schema.default)
						: column.default(schema.default);
			}
			return column as ColumnToDrizzle<C>;
		}

		case 'date': {
			// Pattern 2: Custom builder handles timezone serialization internally
			// Stored as TEXT in format "ISO_UTC|TIMEZONE" (e.g., "2024-01-01T20:00:00.000Z|America/New_York")
			const column = date(schema);
			return column as ColumnToDrizzle<C>;
		}

		case 'select': {
			// Single-value enum stored as TEXT with Drizzle's enum constraint.
			// Note: SelectColumnSchema only allows static defaults (TOptions[number]),
			// not function defaults, unlike other column types. This is intentional
			// since enum values are typically known at schema definition time.
			let column = text(columnName, { enum: schema.options });
			if (!schema.nullable) column = column.notNull();
			if (schema.default !== undefined) {
				column = column.default(schema.default);
			}
			return column as ColumnToDrizzle<C>;
		}

		case 'multi-select': {
			// Pattern 2: Custom builder handles JSON array serialization and validation
			// Stored as TEXT containing JSON array of strings
			const column = tags(schema);
			return column as ColumnToDrizzle<C>;
		}

		case 'json': {
			// Pattern 2: Custom builder handles JSON serialization and arktype validation
			// Stored as TEXT containing validated JSON
			const column = json(schema);
			return column as ColumnToDrizzle<C>;
		}

		default:
			// @ts-expect-error - exhaustive check ensures all cases are handled
			throw new Error(`Unknown column type: ${schema.type}`);
	}
}
