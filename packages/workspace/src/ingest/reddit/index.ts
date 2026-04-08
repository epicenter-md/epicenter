/**
 * Reddit Import Entry Point
 *
 * Main API for importing Reddit GDPR exports into the workspace.
 *
 * Architecture:
 *   parse.ts → csv-schemas.ts → workspace
 *
 * The csvSchemas handle validation, parsing, and transformation in ONE pass.
 * No separate validation or transform layers needed.
 *
 * Usage:
 * ```typescript
 * import { importRedditExport, redditWorkspace } from './ingest/reddit';
 * import { createWorkspace } from 'epicenter/static';
 *
 * const client = createWorkspace(redditWorkspace);
 * const stats = await importRedditExport(zipFile, client);
 * console.log(`Imported ${stats.totalRows} rows`);
 * ```
 */

import { type } from 'arktype';
import { snakify } from '../../shared/snakify.js';
import { createWorkspace } from '../../workspace/create-workspace.js';
import { csvSchemas, type TableName } from './csv-schemas.js';
import { type ParsedRedditData, parseRedditZip } from './parse.js';
import { type RedditWorkspace, redditWorkspace } from './workspace.js';

export { type RedditWorkspace, redditWorkspace };

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ImportError = {
	table: string;
	rowIndex: number;
	error: string;
};

export type ImportStats = {
	tables: Record<string, number>;
	kv: number;
	totalRows: number;
	errors: ImportError[];
	skipped: number;
};

export type ImportProgress = {
	phase: 'parse' | 'transform' | 'insert';
	current: number;
	total: number;
	table?: string;
};

// Derive workspace client type (not exported — callers use createWorkspace(redditWorkspace) directly)
const _createRedditWorkspace = () => createWorkspace(redditWorkspace);
type RedditWorkspaceClient = ReturnType<typeof _createRedditWorkspace>;

/** Import rows for a single table with per-row error recovery */
function importTableRows(
	csvData: Record<string, string>[],
	schema: (data: unknown) => unknown,
	tableClient: {
		set(row: { id: string; _v: 1 }): void;
	},
	tableName: string,
	errors: ImportError[],
): { imported: number; skipped: number } {
	let imported = 0;
	let skipped = 0;

	for (let i = 0; i < csvData.length; i++) {
		const result = schema(csvData[i]);
		if (result instanceof type.errors) {
			errors.push({
				table: tableName,
				rowIndex: i,
				error: result.summary,
			});
			skipped++;
			continue;
		}
		tableClient.set({ ...(result as { id: string }), _v: 1 });
		imported++;
	}

	return { imported, skipped };
}

const tableNames = Object.keys(csvSchemas) as TableName[];

// ═══════════════════════════════════════════════════════════════════════════════
// KV TRANSFORM
// ═══════════════════════════════════════════════════════════════════════════════

type KvData = {
	statistics: Record<string, string> | null;
	preferences: Record<string, string> | null;
};

function transformKv(raw: ParsedRedditData): KvData {
	// Statistics → JSON object
	let statistics: Record<string, string> | null = null;
	if (raw.statistics && raw.statistics.length > 0) {
		statistics = {};
		for (const row of raw.statistics) {
			if (row.statistic && row.value) statistics[row.statistic] = row.value;
		}
	}

	// Preferences → JSON object
	let preferences: Record<string, string> | null = null;
	if (raw.user_preferences && raw.user_preferences.length > 0) {
		preferences = {};
		for (const row of raw.user_preferences) {
			if (row.preference && row.value) preferences[row.preference] = row.value;
		}
	}

	return {
		statistics,
		preferences,
	};
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import a Reddit GDPR export ZIP file into the workspace.
 *
 * @param input - ZIP file as Blob, File, or ArrayBuffer
 * @param workspace - Reddit workspace client from createWorkspace(redditWorkspace)
 * @param options - Optional progress callback
 * @returns Import statistics
 */
export async function importRedditExport(
	input: Blob | ArrayBuffer,
	workspace: RedditWorkspaceClient,
	options?: { onProgress?: (progress: ImportProgress) => void },
): Promise<ImportStats> {
	const stats: ImportStats = {
		tables: {},
		kv: 0,
		totalRows: 0,
		errors: [],
		skipped: 0,
	};

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 1: PARSE ZIP → RAW CSV DATA
	// ═══════════════════════════════════════════════════════════════════════════
	options?.onProgress?.({ phase: 'parse', current: 0, total: 1 });
	const rawData = await parseRedditZip(input);

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 2: TRANSFORM + INSERT (unified via csvSchemas)
	// ═══════════════════════════════════════════════════════════════════════════
	let tableIndex = 0;

	// Batch all table and KV inserts into a single Y.Doc transaction
	workspace.batch(() => {
		for (const table of tableNames) {
			options?.onProgress?.({
				phase: 'transform',
				current: tableIndex++,
				total: tableNames.length,
				table,
			});

			const csv = snakify(table);
			const csvData = rawData[csv as keyof ParsedRedditData] ?? [];

			const { imported, skipped: tableSkipped } = importTableRows(
				csvData,
				csvSchemas[table] as (data: unknown) => unknown,
				workspace.tables[table as keyof typeof workspace.tables],
				table,
				stats.errors,
			);
			stats.tables[table] = imported;
			stats.skipped += tableSkipped;
		}

		// ═══════════════════════════════════════════════════════════════════════
		// PHASE 3: KV STORE
		// ═══════════════════════════════════════════════════════════════════════
		options?.onProgress?.({ phase: 'insert', current: 0, total: 1 });
		const kvData = transformKv(rawData);
		for (const [key, value] of Object.entries(kvData) as [
			keyof KvData,
			KvData[keyof KvData],
		][]) {
			if (value !== null) {
				workspace.kv.set(key, value as string & Record<string, string>);
				stats.kv++;
			}
		}
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// DONE
	// ═══════════════════════════════════════════════════════════════════════════
	stats.totalRows =
		Object.values(stats.tables).reduce((a, b) => a + b, 0) + stats.kv;

	return stats;
}

/**
 * Preview a Reddit GDPR export without importing.
 * Returns row counts per table.
 */
export async function previewRedditExport(input: Blob | ArrayBuffer): Promise<{
	tables: Record<string, number>;
	kv: Record<string, boolean>;
	totalRows: number;
}> {
	const rawData = await parseRedditZip(input);

	// Compute table row counts
	const tables: Record<string, number> = {};
	for (const table of tableNames) {
		const csv = snakify(table);
		const csvData = rawData[csv as keyof ParsedRedditData] ?? [];
		tables[table] = csvData.length;
	}

	// Check which KV fields have values
	const kvData = transformKv(rawData);
	const kv: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(kvData)) {
		kv[key] = value !== null;
	}

	const totalRows = Object.values(tables).reduce((a, b) => a + b, 0);

	return { tables, kv, totalRows };
}
