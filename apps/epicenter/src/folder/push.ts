/**
 * Send what the folder is asking for, and settle the receipts behind it.
 *
 * Settling is the half that is easy to miss. A patch that lands and leaves the
 * old receipt in place means the field stays pending forever: `status` never
 * goes quiet, and the renderer keeps protecting an edit that already arrived. So
 * a successful write records what the file now holds, in the same step.
 *
 * Every entry is independent, because no transaction spans rows (ADR-0207). An
 * unreadable file, a duplicated id, and a good edit are three outcomes, and the
 * good one lands regardless of the other two.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject, RowAddress } from '@epicenter/lens';

import type { ReceiptStore } from './receipts.js';
import { renderRow } from './render.js';
import { type ScanEntry, scanFolder, type TableLookup } from './scan.js';

/**
 * The write side of the replica, narrowed to what a folder needs.
 *
 * Three verbs, no reads. Narrow because it is the seam a test replaces, and a
 * folder that could read rows would be tempted to compare against them, which is
 * the conflict surface this design does not have.
 */
export type FolderWriter = {
	/** Mint a row and return its id. */
	create(
		namespace: string,
		tableName: string,
		fields: JsonObject,
	): Promise<string>;
	/** Apply a partial change. `false` when the row no longer exists. */
	patch(address: RowAddress, changes: JsonObject): Promise<boolean>;
	/** Remove a row. `false` when it was already gone. */
	remove(address: RowAddress): Promise<boolean>;
};

export type SkipReason =
	| 'unbased'
	| 'duplicate'
	| 'refused'
	| 'unknown-table'
	| 'row-vanished';

export type PushReport = {
	created: number;
	patched: number;
	deleted: number;
	skipped: { path: string; reason: SkipReason }[];
};

/** Fold a plan's `set` and `unset` into the one partial `patch` accepts. */
function changesFrom(set: JsonObject, unset: readonly string[]): JsonObject {
	const changes: JsonObject = { ...set };
	// A removed optional field is `undefined`, never `null`: the nullish contract
	// the whole round trip keeps.
	for (const field of unset) changes[field] = undefined as never;
	return changes;
}

export async function pushFolder({
	root,
	receipts,
	lookup,
	writer,
	entries = scanFolder({ root, receipts, lookup }),
}: {
	root: string;
	receipts: ReceiptStore;
	lookup: TableLookup;
	writer: FolderWriter;
	/** Injectable so a caller can push exactly what it showed you. */
	entries?: ScanEntry[];
}): Promise<PushReport> {
	const report: PushReport = {
		created: 0,
		patched: 0,
		deleted: 0,
		skipped: [],
	};
	const skip = (path: string, reason: SkipReason) =>
		report.skipped.push({ path, reason });

	for (const entry of entries) {
		switch (entry.kind) {
			case 'refused':
			case 'duplicate':
			case 'unknown-table': {
				skip(entry.path, entry.kind);
				break;
			}

			case 'gone': {
				await writer.remove(entry.address);
				// Forgotten either way: the row is gone from the folder's point of
				// view, and a receipt for it would report the same deletion forever.
				receipts.forget(entry.address);
				report.deleted += 1;
				break;
			}

			case 'new': {
				if (entry.plan.kind !== 'create') break;
				const definition = lookup(entry.namespace, entry.tableName);
				if (definition === undefined) {
					skip(entry.path, 'unknown-table');
					break;
				}

				const rowId = await writer.create(
					entry.namespace,
					entry.tableName,
					entry.fields,
				);

				// The id goes back into the file, at the name you gave it. Without
				// this the next scan sees another id-less file and mints another row.
				writeFileSync(
					join(root, entry.path),
					renderRow({ id: rowId, fields: entry.fields, definition }),
				);
				receipts.record({
					address: {
						namespace: entry.namespace,
						tableName: entry.tableName,
						rowId,
					},
					path: entry.path,
					fields: entry.fields,
				});
				report.created += 1;
				break;
			}

			case 'claim': {
				if (entry.plan.kind === 'unbased') {
					skip(entry.path, 'unbased');
					break;
				}
				if (entry.plan.kind !== 'patch') break;
				const { set, unset } = entry.plan;
				if (Object.keys(set).length === 0 && unset.length === 0) break;

				const landed = await writer.patch(
					entry.address,
					changesFrom(set, unset),
				);
				if (!landed) {
					// `patch` does not create (ADR-0206), so a vanished row is a report,
					// not a resurrection. The receipt stays, so the edit survives to be
					// retried or discarded.
					skip(entry.path, 'row-vanished');
					break;
				}

				// Settle: the file and the row now agree on everything that was
				// sent, so what the file holds IS the new receipt. Skipping this is
				// what would leave the field pending forever.
				receipts.record({
					address: entry.address,
					path: entry.path,
					fields: entry.fields,
				});
				report.patched += 1;
				break;
			}
		}
	}

	return report;
}
