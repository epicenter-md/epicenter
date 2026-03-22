// @ts-nocheck
import * as Y from 'yjs';
import { getStaticWorkspace } from '$lib/workspaces/static/service';
import {
	discoverKvKeys,
	discoverTables,
	readAllKv,
	readTableRows,
} from '$lib/yjs/discover';
import type { LayoutLoad } from './$types';

/**
 * Load a static workspace by ID.
 *
 * Flow:
 * 1. Look up registry entry (may not exist for ad-hoc viewing)
 * 2. Create a local Y.Doc
 * 3. Discover tables and KV keys
 */
export const load = async ({ params }: Parameters<LayoutLoad>[0]) => {
	const workspaceId = params.id;

	// Get registry entry (may not exist for ad-hoc viewing)
	const entry = await getStaticWorkspace(workspaceId);

	// Create a local Y.Doc (no sync connection)
	const ydoc = new Y.Doc({ guid: workspaceId });

	// Discover structure
	const tables = discoverTables(ydoc);
	const kvKeys = discoverKvKeys(ydoc);

	// Read initial data for all tables
	const tableData: Record<string, Record<string, unknown>[]> = {};
	for (const tableName of tables) {
		tableData[tableName] = readTableRows(ydoc, tableName);
	}

	// Read all KV values
	const kvData = readAllKv(ydoc);

	return {
		workspaceId,
		entry, // May be null for ad-hoc viewing
		ydoc,
		tables,
		kvKeys,
		tableData,
		kvData,
		syncStatus: 'local',
		displayName: entry?.name ?? workspaceId,
	};
};
