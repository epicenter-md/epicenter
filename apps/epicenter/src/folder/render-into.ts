/**
 * Write one row into the folder without stepping on an edit you have not pushed.
 *
 * The rule, per field: if the file still holds what was written into it, write
 * what the row says now. If it does not, you changed it, so leave your value
 * alone. Nothing here is about avoiding a conflict, because there are no
 * conflicts (ADR-0207). It is only that overwriting an unpushed edit loses work.
 *
 * The receipt that comes back out is deliberately not the row. It is what the
 * file now holds *minus* your pending edits, because the receipt's whole job is
 * to be the thing your edits are measured against. A field you changed keeps its
 * old receipt value, so the next push still sees the change.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JsonObject, JsonValue, RowAddress } from '@epicenter/lens';
import { canonicalJson } from '@epicenter/lens';
import type { TableDefinition } from '@epicenter/lens/legacy';

import { parseRow } from './parse.js';
import type { Receipt, ReceiptStore } from './receipts.js';
import { renderRow } from './render.js';

/** Where a row is written when nothing has claimed a name for it yet. */
export function defaultPathFor(address: RowAddress): string {
	return `${address.namespace}/${address.tableName}/${address.rowId}.md`;
}

function sameField(left: JsonValue | undefined, right: JsonValue | undefined) {
	if (left === undefined || right === undefined) return left === right;
	return canonicalJson(left) === canonicalJson(right);
}

/**
 * Read a file as it stands, or `undefined` if it is absent or unreadable.
 *
 * An unreadable file is treated as absent on purpose: the renderer's job is to
 * keep the folder current, and refusing to write because the previous contents
 * were malformed would leave a row permanently unrepresented. The scan is what
 * reports the file to you; this only declines to preserve edits it cannot read.
 */
function readFields(
	absolutePath: string,
	definition: TableDefinition,
): JsonObject | undefined {
	let text: string;
	try {
		text = readFileSync(absolutePath, 'utf8');
	} catch {
		return undefined;
	}
	return parseRow(text, definition).data?.fields;
}

export type RenderOutcome =
	| { kind: 'written'; path: string; receipt: Receipt }
	| { kind: 'removed'; path: string };

/**
 * Bring one row's file up to date, and record what was written.
 *
 * Pass `fields: undefined` for a row that is gone, which removes the file and
 * forgets the receipt.
 */
export function renderIntoFolder({
	root,
	receipts,
	address,
	fields,
	definition,
}: {
	root: string;
	receipts: ReceiptStore;
	address: RowAddress;
	/** The row's fields now, or undefined if the row no longer exists. */
	fields: JsonObject | undefined;
	definition: TableDefinition;
}): RenderOutcome {
	const previous = receipts.get(address);
	const path = previous?.path ?? defaultPathFor(address);
	const absolutePath = join(root, path);

	if (fields === undefined) {
		receipts.forget(address);
		// `force` because a file someone already deleted is the state we wanted.
		rmSync(absolutePath, { force: true });
		return { kind: 'removed', path };
	}

	const onDisk =
		previous === undefined ? undefined : readFields(absolutePath, definition);

	// No receipt, or a file we cannot read: nothing to preserve, so the row wins
	// outright and the receipt becomes the row.
	const mine = onDisk ?? previous?.fields;
	const base = previous?.fields;

	const forFile: JsonObject = {};
	const forReceipt: JsonObject = {};
	for (const field of new Set([
		...Object.keys(fields),
		...Object.keys(base ?? {}),
		...Object.keys(mine ?? {}),
	])) {
		const touched =
			base !== undefined &&
			mine !== undefined &&
			!sameField(mine[field], base[field]);
		const forFileValue = touched ? mine?.[field] : fields[field];
		// A touched field keeps its OLD receipt value, so the edit stays visible to
		// the next push. An untouched one takes the row, since that is what the
		// file now holds.
		const forReceiptValue = touched ? base[field] : fields[field];
		if (forFileValue !== undefined) forFile[field] = forFileValue;
		if (forReceiptValue !== undefined) forReceipt[field] = forReceiptValue;
	}

	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(
		absolutePath,
		renderRow({ id: address.rowId, fields: forFile, definition }),
	);

	const receipt: Receipt = { address, path, fields: forReceipt };
	receipts.record(receipt);
	return { kind: 'written', path, receipt };
}
