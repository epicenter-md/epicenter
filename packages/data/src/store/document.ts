import type { JsonObject, JsonValue } from '@epicenter/lens';
import { RESERVED_ATTRIBUTE_PREFIX } from '@epicenter/lens/lens';
import * as Y from '@y/y';

/**
 * The one reserved attribute, carrying both existence and liveness (ADR-0212).
 *
 * A nested type with no `!presence` never existed. It is spelled with the
 * reserved prefix so it can never collide with a declared field, and the lens
 * refuses any field name that begins with that prefix.
 */
export const PRESENCE_ATTRIBUTE = `${RESERVED_ATTRIBUTE_PREFIX}presence`;

/**
 * The attribute holding the container a row's document lives in (ADR-0130/0215).
 *
 * Allocated when the row is created, never lazily on first access. Lazy
 * allocation is a write at a well-known address, so two devices opening a note
 * for the first time would each mint their own container and map LWW would
 * discard one along with everything written into it. Creating it with the row
 * moves the only race to row creation, which minted ids make unreachable.
 */
export const DOCUMENT_ATTRIBUTE = `${RESERVED_ATTRIBUTE_PREFIX}doc`;

export type Presence = 'present' | 'absent';

/** The application's document: one per app, holding every table (ADR-0215). */
export function createAppDocument(): Y.Doc {
	// `gc: true` is what collapses a field edited 5,000 times to two structs. It
	// is also why history lives outside the CRDT entirely (ADR-0214).
	return new Y.Doc({ gc: true });
}

/**
 * The root holding one table's rows, minting it if this document has never
 * seen it.
 *
 * Minting is safe here and nowhere else. `Doc.get` is
 * `map.setIfUndefined(this.share, key, ...)`, so it creates on miss, and a root
 * can never be removed: reaching into `doc.share` and deleting one corrupts the
 * encoder outright. Every key that reaches this function is a table name the
 * lens declares, so the set of roots is bounded by the lens rather than by user
 * input. A row id must never be passed here; rows are attributes on this root,
 * which is what keeps `doc.share` at table count rather than row count.
 *
 * That bound is the whole reason for the nested grammar. `Item.write` calls
 * `findRootTypeKey`, a linear scan of `doc.share`, so one root per row makes
 * encoding quadratic in rows: 5,417 ms at 20,000 rows against 13 ms nested.
 */
export function tableRoot(document: Y.Doc, tableName: string): Y.Type {
	return document.get(tableName);
}

/** Whether this document has ever held the named table. Never mints. */
export function hasTable(document: Y.Doc, tableName: string): boolean {
	return document.share.has(tableName);
}

/**
 * One row's nested type, or undefined when the address has never been used.
 *
 * Unlike `Doc.get`, `getAttr` does not mint: verified against
 * `@y/y@14.0.0-rc.24`, reading an unknown row id leaves the table root's
 * attribute keys unchanged. So a misspelled row id costs nothing here, while a
 * misspelled table name would cost a permanent root.
 */
function rowType(root: Y.Type, rowId: string): Y.Type | undefined {
	const value = root.getAttr(rowId as never) as unknown;
	return value instanceof Y.Type ? value : undefined;
}

function presenceOf(row: Y.Type): Presence | undefined {
	const value = row.getAttr(PRESENCE_ATTRIBUTE as never) as unknown;
	return value === 'present' || value === 'absent' ? value : undefined;
}

/** Whether this address currently holds a live row. */
export function isLive(root: Y.Type, rowId: string): boolean {
	const row = rowType(root, rowId);
	return row !== undefined && presenceOf(row) === 'present';
}

/**
 * One live row's declared fields, or undefined when the address is absent.
 *
 * Reserved attributes are filtered out, so what comes back is only what a lens
 * could have declared. Nothing is validated here: interpreting the payload is
 * the lens's job, and a row this release cannot read must still be readable as
 * raw JSON (ADR-0125).
 */
export function readRow(root: Y.Type, rowId: string): JsonObject | undefined {
	const row = rowType(root, rowId);
	if (row === undefined || presenceOf(row) !== 'present') return undefined;
	const payload: JsonObject = {};
	for (const key of row.attrKeys()) {
		const name = key as string;
		if (name.startsWith(RESERVED_ATTRIBUTE_PREFIX)) continue;
		payload[name] = row.getAttr(name as never) as JsonValue;
	}
	return payload;
}

/**
 * Every live row id in this table.
 *
 * Pays for every row ever deleted, because a table root grows monotonically and
 * liveness is an attribute on each corpse: measured, listing a thousand live
 * rows among a hundred thousand takes 24.9 ms. If a table ever gets slow, the
 * fix is a second attribute on the root naming only the live rows, read in one
 * call rather than one per row. Not built; no table is near this.
 */
export function listRowIds(root: Y.Type): string[] {
	const ids: string[] = [];
	for (const key of root.attrKeys()) {
		const rowId = key as string;
		if (isLive(root, rowId)) ids.push(rowId);
	}
	return ids.sort();
}

/**
 * Write fields into one row, bringing the address to life if it is not already.
 *
 * Caller-supplied fields only: an absent key is left alone rather than being
 * filled from a declared default, because a default is applied at read time and
 * is never written (ADR-0213). Must run inside a `transact`, so presence and
 * the fields it admits commit together.
 */
export function writeRow(
	root: Y.Type,
	rowId: string,
	fields: JsonObject,
): void {
	let row = rowType(root, rowId);
	if (row === undefined) {
		row = new Y.Type();
		root.setAttr(rowId as never, row as never);
	}
	// Creating at an absent address sets presence back to present. The previous
	// content is gone from the CRDT and comes back only from history: an address
	// is reusable, the content is not (ADR-0212).
	row.setAttr(PRESENCE_ATTRIBUTE as never, 'present' as never);
	// Eagerly, and only when absent, so re-creating at a reused address gets a
	// fresh one and an existing row keeps the container it already has.
	if (!(row.getAttr(DOCUMENT_ATTRIBUTE as never) instanceof Y.Type)) {
		row.setAttr(DOCUMENT_ATTRIBUTE as never, new Y.Type() as never);
	}
	for (const [name, value] of Object.entries(fields)) {
		row.setAttr(name as never, value as never);
	}
}

/**
 * The container holding one row's application-owned roots, or undefined when
 * the row is not live.
 *
 * A pure read: the container was allocated with the row. Epicenter never looks
 * inside, and the application names its own roots and picks their formats.
 */
export function documentContainer(
	root: Y.Type,
	rowId: string,
): Y.Type | undefined {
	if (!isLive(root, rowId)) return undefined;
	const row = rowType(root, rowId);
	const container = row?.getAttr(DOCUMENT_ATTRIBUTE as never) as unknown;
	return container instanceof Y.Type ? container : undefined;
}

/**
 * Clear one row's content and mark it absent. Returns whether it was live.
 *
 * Clearing is what reclaims space, and it is not optional. Measured over 1,000
 * rows: setting the flag alone leaves the document *larger* than before
 * (2,908 KB against a 2,888 KB baseline), because the content is all still
 * there; clearing first takes it to 86 KB. A dead row then costs a flat 170
 * bytes forever, which compaction does not reduce.
 *
 * The row's nested type is emptied rather than removed from the table root.
 * Deleting the row's attribute instead destroys a concurrent edit; clearing
 * fields and flagging converges with the tombstone held and the peer's edit
 * retained, which is how deletion has to work here.
 */
export function deleteRow(root: Y.Type, rowId: string): boolean {
	const row = rowType(root, rowId);
	if (row === undefined || presenceOf(row) !== 'present') return false;
	for (const key of [...row.attrKeys()]) {
		const name = key as string;
		if (name === PRESENCE_ATTRIBUTE) continue;
		row.deleteAttr(name);
	}
	row.setAttr(PRESENCE_ATTRIBUTE as never, 'absent' as never);
	return true;
}
