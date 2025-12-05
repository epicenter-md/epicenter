/**
 * SQLite index - Syncs YJS changes to SQLite database
 *
 * Main entry point for the SQLite index. Exports the sqliteIndex function
 * and utilities for working with Drizzle schemas.
 */

// Schema utilities (builders + converter)
export type { WorkspaceSchemaToDrizzleTables } from './schema';
export {
	boolean,
	convertTableSchemaToDrizzle,
	convertWorkspaceSchemaToDrizzle,
	date,
	id,
	integer,
	real,
	tags,
	text,
} from './schema';
// Main index implementation
export { sqliteIndex } from './sqlite-index';
