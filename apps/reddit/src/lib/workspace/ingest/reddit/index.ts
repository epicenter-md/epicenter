/**
 * Reddit GDPR export importer.
 *
 * Parses the ZIP, validates and transforms each supported CSV row, and returns
 * plain data. Persistence belongs to the consuming application.
 */

import { type } from 'arktype';
import { snakify } from '../snakify.js';
import { csvSchemas, type TableName } from './csv-schemas.js';
import { type ParsedRedditData, parseRedditZip } from './parse.js';

export type ImportError = {
	table: TableName;
	rowIndex: number;
	error: string;
};

export type ImportStats = {
	tables: Record<TableName, number>;
	metadata: number;
	totalRows: number;
	errors: ImportError[];
	skipped: number;
};

export type ImportProgress = {
	phase: 'parse' | 'transform';
	current: number;
	total: number;
	table?: TableName;
};

export type RedditTables = {
	[TName in TableName]: (typeof csvSchemas)[TName]['infer'][];
};

export type RedditMetadata = {
	statistics: Record<string, string> | null;
	preferences: Record<string, string> | null;
};

export type RedditImportResult = {
	tables: RedditTables;
	metadata: RedditMetadata;
	stats: ImportStats;
};

const tableNames = Object.keys(csvSchemas) as TableName[];

function transformTableRows(
	csvData: Record<string, string>[],
	schema: (data: unknown) => unknown,
	table: TableName,
	errors: ImportError[],
): { rows: unknown[]; skipped: number } {
	const rows: unknown[] = [];
	let skipped = 0;

	for (let rowIndex = 0; rowIndex < csvData.length; rowIndex++) {
		const result = schema(csvData[rowIndex]);
		if (result instanceof type.errors) {
			errors.push({ table, rowIndex, error: result.summary });
			skipped++;
			continue;
		}
		rows.push(result);
	}

	return { rows, skipped };
}

function transformMetadata(raw: ParsedRedditData): RedditMetadata {
	let statistics: Record<string, string> | null = null;
	if (raw.statistics.length > 0) {
		statistics = {};
		for (const row of raw.statistics) {
			if (row.statistic && row.value) statistics[row.statistic] = row.value;
		}
	}

	let preferences: Record<string, string> | null = null;
	if (raw.user_preferences.length > 0) {
		preferences = {};
		for (const row of raw.user_preferences) {
			if (row.preference && row.value) preferences[row.preference] = row.value;
		}
	}

	return { statistics, preferences };
}

/**
 * Parse and transform a Reddit GDPR export without creating a database.
 */
export async function importRedditExport(
	input: Blob | ArrayBuffer,
	{ onProgress }: { onProgress?: (progress: ImportProgress) => void } = {},
): Promise<RedditImportResult> {
	onProgress?.({ phase: 'parse', current: 0, total: 1 });
	const rawData = await parseRedditZip(input);

	const errors: ImportError[] = [];
	let skipped = 0;
	const tableEntries = tableNames.map((table, current) => {
		onProgress?.({
			phase: 'transform',
			current,
			total: tableNames.length,
			table,
		});

		const csv = snakify(table);
		const csvData = rawData[csv as keyof ParsedRedditData] ?? [];
		const transformed = transformTableRows(
			csvData,
			csvSchemas[table] as (data: unknown) => unknown,
			table,
			errors,
		);
		skipped += transformed.skipped;
		return [table, transformed.rows] as const;
	});
	const tables = Object.fromEntries(tableEntries) as RedditTables;
	const metadata = transformMetadata(rawData);
	const tableCounts = Object.fromEntries(
		tableNames.map((table) => [table, tables[table].length]),
	) as Record<TableName, number>;
	const metadataCount = Object.values(metadata).filter(
		(value) => value !== null,
	).length;
	const totalRows =
		Object.values(tableCounts).reduce((total, count) => total + count, 0) +
		metadataCount;

	return {
		tables,
		metadata,
		stats: {
			tables: tableCounts,
			metadata: metadataCount,
			totalRows,
			errors,
			skipped,
		},
	};
}
