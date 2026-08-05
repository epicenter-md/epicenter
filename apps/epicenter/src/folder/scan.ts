/**
 * Read the whole folder and say what it is asking for.
 *
 * A scan, not a watcher. It runs when someone types `status` or `push`, reads
 * and parses every file, and writes nothing. That makes an edit made while the
 * host was stopped indistinguishable from one made while it was running, which
 * is the property that lets the folder be edited by anything at all (ADR-0207).
 *
 * Every file is judged on its own. No transaction spans rows, so an unreadable
 * file, a file naming a table nobody declares, and a perfectly good file are
 * three independent outcomes rather than one failed batch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject, RowAddress, TableDefinition } from '@epicenter/lens';

import { parseRow, type RefusedClaim } from './parse.js';
import { type PushPlan, planPush } from './plan.js';
import type { ReceiptStore } from './receipts.js';

export type ScanEntry =
	/** A readable file with an id, what it holds, and what pushing it would do. */
	| {
			kind: 'claim';
			path: string;
			address: RowAddress;
			/** What the file holds now. Becomes the receipt once a push lands. */
			fields: JsonObject;
			plan: PushPlan;
	  }
	/** A readable file with no id, asking for a row to be minted. */
	| {
			kind: 'new';
			path: string;
			namespace: string;
			tableName: string;
			fields: JsonObject;
			plan: PushPlan;
	  }
	/** The file could not be read as a claim. Named, and left alone. */
	| { kind: 'refused'; path: string; reason: RefusedClaim }
	/** A receipt whose row no file claims any more: a pending row deletion. */
	| { kind: 'gone'; path: string; address: RowAddress }
	/**
	 * Two or more files carry the same id, which `cp a.md b.md` produces. Refused
	 * by naming every path rather than guessing which one is the row.
	 */
	| { kind: 'duplicate'; path: string; address: RowAddress; paths: string[] }
	/** A file under a namespace or table no loaded Lens declares. */
	| {
			kind: 'unknown-table';
			path: string;
			namespace: string;
			tableName: string;
	  };

/** Resolve the table that owns a folder location, if any Lens declares it. */
export type TableLookup = (
	namespace: string,
	tableName: string,
) => TableDefinition | undefined;

function addressKey(address: RowAddress): string {
	return `${address.namespace}\u0000${address.tableName}\u0000${address.rowId}`;
}

/**
 * List every materialized file, relative to the root, as `<ns>/<table>/<name>.md`.
 *
 * Exactly three segments, because an address is exactly three deep (ADR-0206).
 * Anything shallower or deeper is not something the renderer wrote and is not
 * this function's business.
 */
export function listFolderFiles(root: string): string[] {
	return [...new Bun.Glob('*/*/*.md').scanSync({ cwd: root })]
		.map((path) => path.split('\\').join('/'))
		.sort();
}

export function scanFolder({
	root,
	receipts,
	lookup,
	files = listFolderFiles(root),
}: {
	root: string;
	receipts: ReceiptStore;
	lookup: TableLookup;
	/** Injectable for tests; defaults to reading the real directory. */
	files?: string[];
}): ScanEntry[] {
	const entries: ScanEntry[] = [];
	const pathsByAddress = new Map<string, string[]>();
	const seen = new Set<string>();

	for (const path of files) {
		const [namespace = '', tableName = ''] = path.split('/');

		const definition = lookup(namespace, tableName);
		if (definition === undefined) {
			entries.push({ kind: 'unknown-table', path, namespace, tableName });
			continue;
		}

		const { data: claim, error } = parseRow(
			readFileSync(join(root, path), 'utf8'),
			definition,
		);
		if (error) {
			entries.push({ kind: 'refused', path, reason: error });
			continue;
		}

		if (claim.id === undefined) {
			entries.push({
				kind: 'new',
				path,
				namespace,
				tableName,
				fields: claim.fields,
				plan: planPush({ claim, base: undefined }),
			});
			continue;
		}

		// Matched by the id in frontmatter, never by the filename, so renaming a
		// file carries its receipt with it instead of reading as a deletion plus a
		// baseless stranger (ADR-0207).
		const address = { namespace, tableName, rowId: claim.id };
		const key = addressKey(address);
		seen.add(key);
		pathsByAddress.set(key, [...(pathsByAddress.get(key) ?? []), path]);
		entries.push({
			kind: 'claim',
			path,
			address,
			fields: claim.fields,
			plan: planPush({ claim, base: receipts.get(address)?.fields }),
		});
	}

	// A row no file claims any more is the one place the folder's *absence*
	// carries intent, so it is always reported and never inferred away.
	for (const receipt of receipts.all()) {
		if (seen.has(addressKey(receipt.address))) continue;
		entries.push({
			kind: 'gone',
			path: receipt.path,
			address: receipt.address,
		});
	}

	return entries.map((entry) => {
		if (entry.kind !== 'claim') return entry;
		const paths = pathsByAddress.get(addressKey(entry.address)) ?? [];
		if (paths.length < 2) return entry;
		return {
			kind: 'duplicate',
			path: entry.path,
			address: entry.address,
			paths,
		};
	});
}
