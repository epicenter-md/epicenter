import type { AnyColumn } from 'drizzle-orm';

import type { ColumnDescriptions } from './adapter';
import type { AnyTable } from './db';

export type ReadableColumnInfo = {
	name: string;
	type: unknown;
	nullable: boolean;
	description?: string;
};

export type ReadableTableInfo = {
	name: string;
	columns: ReadableColumnInfo[];
};

/**
 * Convert a Drizzle schema into a readable structure, optionally enriching with Adapter.metadata.
 *
 * When metadata is provided, matching table/column descriptions are included under `description`.
 */
export function readableSchemaInfo<TSchema extends Record<string, AnyTable>>(
	schema: TSchema,
	metadata?: ColumnDescriptions<TSchema>,
): ReadableTableInfo[] {
	const tables = Object.entries<AnyTable>(schema);
	return tables.map(([name, table]) => ({
		name,
		columns: readableTableInfo(
			table,
			metadata?.[name as keyof TSchema] as Record<string, string> | undefined,
		),
	}));
}

function readableTableInfo(
	table: AnyTable,
	tableMetadata?: Record<string, string>,
) {
	const columns = Object.entries<AnyColumn>(table._.columns);
	return columns.map(([name, col]) =>
		readableColumnInfo(name, col, tableMetadata?.[name]),
	);
}

function readableColumnInfo(
	name: string,
	column: AnyColumn,
	description?: string,
): ReadableColumnInfo {
	// Add other fields here we wish to expose
	const base = {
		name,
		type: column.dataType,
		nullable: !column.notNull,
	};
	return description !== undefined ? { ...base, description } : base;
}
