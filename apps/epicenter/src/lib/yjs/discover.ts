import * as Y from 'yjs';

/**
 * LWW entry structure used by YKeyValueLww
 */
type YKeyValueLwwEntry<T = unknown> = {
	key: string;
	val: T;
	ts: number;
};

/**
 * Discover all table names from a Y.Doc by scanning ydoc.share
 * Tables are stored as Y.Arrays with keys like 'table:{name}'
 *
 * Note: ydoc.share contains type references that may not be fully instantiated.
 * We use ydoc.getArray() to force instantiation and check for data.
 */
export function discoverTables(ydoc: Y.Doc): string[] {
	const tables: string[] = [];

	// Get all share keys that look like tables
	for (const key of ydoc.share.keys()) {
		if (key.startsWith('table:')) {
			// Force instantiation by calling getArray
			const array = ydoc.getArray(key);
			// Only include if the array has data
			if (array.length > 0) {
				tables.push(key.slice(6)); // Remove 'table:' prefix
			}
		}
	}

	return tables.sort();
}

/**
 * Discover all KV keys from a Y.Doc
 * KV is stored as a single Y.Array at key 'kv'
 */
export function discoverKvKeys(ydoc: Y.Doc): string[] {
	const kvArray = ydoc.getArray<YKeyValueLwwEntry>('kv');
	const keys = new Set<string>();

	for (const entry of kvArray.toArray()) {
		if (entry && typeof entry === 'object' && 'key' in entry) {
			keys.add(entry.key);
		}
	}

	return [...keys].sort();
}

/**
 * Read all rows from a table (untyped)
 * Returns deduplicated rows using LWW semantics
 *
 * YKeyValueLww stores rows as: { key: rowId, val: rowObject, ts: timestamp }
 * Multiple entries may exist for the same key; we keep the one with highest ts.
 */
export function readTableRows(
	ydoc: Y.Doc,
	tableName: string,
): Record<string, unknown>[] {
	const array = ydoc.getArray<YKeyValueLwwEntry>(`table:${tableName}`);
	const entries = array.toArray();

	// LWW deduplication: for each key, keep the entry with highest timestamp
	const rowMap = new Map<string, { val: unknown; ts: number }>();

	for (const entry of entries) {
		if (!entry?.key || entry.val === undefined) continue;

		const existing = rowMap.get(entry.key);
		if (!existing || entry.ts > existing.ts) {
			rowMap.set(entry.key, { val: entry.val, ts: entry.ts });
		}
	}

	// Convert to array sorted by most recent timestamp
	return [...rowMap.entries()]
		.sort(([, a], [, b]) => b.ts - a.ts)
		.map(([, { val }]) => val as Record<string, unknown>);
}

/**
 * Read a KV value by key (untyped)
 * Uses LWW semantics to find the latest value
 */
export function readKvValue(ydoc: Y.Doc, key: string): unknown | undefined {
	const kvArray = ydoc.getArray<YKeyValueLwwEntry>('kv');

	let latest: YKeyValueLwwEntry | undefined;

	for (const entry of kvArray.toArray()) {
		if (entry?.key === key) {
			if (!latest || entry.ts > latest.ts) {
				latest = entry;
			}
		}
	}

	return latest?.val;
}

/**
 * Read all KV values (untyped)
 */
export function readAllKv(ydoc: Y.Doc): Record<string, unknown> {
	const kvArray = ydoc.getArray<YKeyValueLwwEntry>('kv');
	const result: Record<string, { val: unknown; ts: number }> = {};

	for (const entry of kvArray.toArray()) {
		if (!entry?.key) continue;

		const existing = result[entry.key];
		if (!existing || entry.ts > existing.ts) {
			result[entry.key] = { val: entry.val, ts: entry.ts };
		}
	}

	return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.val]));
}
