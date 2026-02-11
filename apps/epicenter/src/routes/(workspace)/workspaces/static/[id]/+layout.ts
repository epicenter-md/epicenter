import { getStaticWorkspace } from '$lib/workspaces/static/service';
import {
	discoverKvKeys,
	discoverTables,
	readAllKv,
	readTableRows,
} from '$lib/yjs/discover';
import {
	createYSweetConnection,
	getDefaultSyncUrl,
} from '$lib/yjs/y-sweet-connection';
import type { LayoutLoad } from './$types';

/**
 * Load a static workspace by ID.
 *
 * Flow:
 * 1. Look up registry entry (may not exist for ad-hoc viewing)
 * 2. Create Y-Sweet connection
 * 3. Wait for initial sync
 * 4. Discover tables and KV keys
 */
export const load: LayoutLoad = async ({ params }) => {
	const workspaceId = params.id;

	// Get registry entry (may not exist for ad-hoc viewing)
	const entry = await getStaticWorkspace(workspaceId);

	// Determine sync URL
	const syncUrl = entry?.syncUrl ?? getDefaultSyncUrl();

	// Create Y-Sweet connection
	const connection = createYSweetConnection({
		workspaceId,
		serverUrl: syncUrl,
	});

	// Wait for initial sync with timeout
	let syncStatus = 'unknown';
	try {
		await Promise.race([
			connection.whenSynced,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Sync timeout')), 10000),
			),
		]);
		syncStatus = 'synced';
	} catch {
		syncStatus = 'failed';
		// Don't throw - allow viewing even if sync fails
	}

	// Discover structure
	const tables = discoverTables(connection.ydoc);
	const kvKeys = discoverKvKeys(connection.ydoc);

	// Read initial data for all tables
	const tableData: Record<string, Record<string, unknown>[]> = {};
	for (const tableName of tables) {
		tableData[tableName] = readTableRows(connection.ydoc, tableName);
	}

	// Read all KV values
	const kvData = readAllKv(connection.ydoc);

	return {
		workspaceId,
		entry, // May be null for ad-hoc viewing
		connection,
		tables,
		kvKeys,
		tableData,
		kvData,
		syncStatus,
		displayName: entry?.name ?? workspaceId,
	};
};
