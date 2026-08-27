/**
 * Where a row's file lives, in both directions (ADR-0268, ADR-0271).
 *
 * One inverse pair, and the layout rule lives here rather than being spelled
 * twice at opposite ends of the package. The two directions used to be two
 * private functions with the same name in two files, which is how a layout
 * rule drifts: one of them gets a fix and the other does not.
 *
 * The address grammar is what makes this exact rather than approximate. A
 * table name is a bare identifier and a row id is path-safe with no leading
 * dot (`../definition/addresses.js`), so neither can hold a `/` or a `.`
 * that would make a path ambiguous, and nothing here escapes or unescapes
 * anything.
 */

/** One row's file, relative to its workspace's folder. */
export function rowPath(table: string, rowId: string): string {
	return `${table}/${rowId}.md`;
}

/**
 * The row a path names, or `undefined` when the path is not a row file.
 *
 * `undefined` is a fact rather than a failure: a person's folder holds
 * `.DS_Store`, a `README.md` they wrote, and whatever else they put beside
 * their data, and none of that is a reason to refuse their data.
 */
export function parseRowPath(
	path: string,
): { table: string; rowId: string } | undefined {
	if (!path.endsWith('.md')) return undefined;
	const parts = path.slice(0, -'.md'.length).split('/');
	if (parts.length !== 2) return undefined;
	const [table, rowId] = parts;
	if (table === undefined || rowId === undefined) return undefined;
	if (table === '' || rowId === '') return undefined;
	return { table, rowId };
}
