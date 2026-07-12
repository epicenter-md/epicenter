/**
 * Ingest module for importing external data exports.
 *
 * Currently supports:
 * - Reddit GDPR exports
 *
 * @packageDocumentation
 */

// Reddit importer
export {
	type ImportError,
	type ImportProgress,
	type ImportStats,
	importRedditExport,
	type RedditImportResult,
	type RedditMetadata,
	type RedditTables,
} from './reddit/index.js';
// Utilities (for custom importers)
export { CSV, type CsvOptions, parseCsv } from './utils/csv.js';
