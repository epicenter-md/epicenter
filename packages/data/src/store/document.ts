import type { JsonObject, JsonValue } from '@epicenter/workspace';
import { RESERVED_ATTRIBUTE_PREFIX } from '@epicenter/workspace';
import * as Y from '@y/y';

/**
 * The attribute holding the container a row's document lives in (ADR-0130/0215).
 *
 * Allocated when the row is created, never lazily on first access. Lazy
 * allocation is a write at a well-known address, so two devices opening a note
 * for the first time would each mint their own container and map LWW would
 * discard one along with everything written into it. Creating it with the row
 * moves the only race to row creation, which minted ids make unreachable.
 *
 * It is spelled with the reserved prefix so it can never collide with a declared
 * field, and the workspace parser refuses any field name that begins with that
 * prefix.
 */
export const DOCUMENT_ATTRIBUTE = `${RESERVED_ATTRIBUTE_PREFIX}doc`;

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
 * workspace declares, so the set of roots is bounded by the declaration rather
 * than by user input. A row id must never be passed here; rows are attributes on this root,
 * which is what keeps `doc.share` at table count rather than row count.
 *
 * That bound is the whole reason for the nested grammar. `Item.write` calls
 * `findRootTypeKey`, a linear scan of `doc.share`, so one root per row makes
 * encoding quadratic in rows: 5,417 ms at 20,000 rows against 13 ms nested.
 */
export function tableRoot(document: Y.Doc, tableName: string): Y.Type {
	return document.get(tableRootName(tableName));
}

/**
 * A table's root is tagged with its kind; the one non-table root is not.
 *
 * `tables:<name>` for a table and a bare `kv` for the settings root, so a
 * `doc.share` dump reads as a description of the application rather than as a
 * list of nouns whose kind you have to infer. The tag is a KIND, not a path,
 * which is why it is a colon: rows are attributes on the root rather than
 * further segments, so `tables/notes` would invite an address that does not
 * exist.
 *
 * The tag is legibility rather than safety, and it is worth being clear about
 * that. `parseWorkspace` already refuses `kv` as a table name outright, because it
 * would collide with the `db.kv` handle key, so a table can no more reach the
 * settings root than it can be declared. `tables:kv` is a second guard on a
 * collision the first one already made unreachable.
 */
export function tableRootName(tableName: string): string {
	return `tables:${tableName}`;
}

/** The root every application's settings live at (ADR-0216). */
export const KV_ROOT_NAME = 'kv';

/**
 * The KV root, minting it on miss.
 *
 * Separate from `tableRoot` because it is not a table and must not be prefixed
 * as one. Minting is safe for the same reason a table's is: `Doc.get` is
 * `setIfUndefined`, so every device that mints `kv` converges on one root.
 */
export function kvRoot(document: Y.Doc): Y.Type {
	return document.get(KV_ROOT_NAME);
}

/** Whether this document has ever held the named table. Never mints. */
export function hasTable(document: Y.Doc, tableName: string): boolean {
	return document.share.has(tableRootName(tableName));
}

/**
 * One row's nested type, or undefined when the table holds no row there.
 *
 * This is the whole of existence. A row IS a nested type on the table root, so
 * holding one is what it means to exist and removing it is what deletion does.
 * There is no second fact to consult and therefore nothing that can disagree
 * with this one.
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

/** Whether this table holds a row at this address. */
export function hasRow(root: Y.Type, rowId: string): boolean {
	return rowType(root, rowId) !== undefined;
}

/**
 * One row's declared fields, or undefined when the table holds no row there.
 *
 * Reserved attributes are filtered out, so what comes back is only what a
 * workspace could have declared: a row's document container is an attribute
 * like any other and is not part of the payload. Nothing is validated here:
 * interpreting the payload is the declaration's job, and a row this release
 * cannot read must still be readable as raw JSON (ADR-0125).
 */
export function readRow(root: Y.Type, rowId: string): JsonObject | undefined {
	const row = rowType(root, rowId);
	if (row === undefined) return undefined;
	const payload: JsonObject = {};
	for (const key of row.attrKeys()) {
		const name = key as string;
		if (name.startsWith(RESERVED_ATTRIBUTE_PREFIX)) continue;
		payload[name] = row.getAttr(name as never) as JsonValue;
	}
	return payload;
}

/**
 * Every row id in this table, sorted.
 *
 * Pays only for the rows that are there. An earlier design kept a deleted row's
 * container attached to the root and flagged it absent, which made this a scan
 * over every row the table had ever held: measured, listing a thousand rows
 * among a hundred thousand corpses took 24.9 ms. Deletion removes the
 * attribute, so `attrKeys` yields the survivors and the dead are not walked.
 *
 * Still one `getAttr` per key rather than the raw key list, so that this agrees
 * with `readRow` on what a row is. A key holding something other than a nested
 * type is not a row anywhere else in this module, and an id this returns that
 * `get` then reports as absent would be worse than the lookup it saves.
 */
export function listRowIds(root: Y.Type): string[] {
	const ids: string[] = [];
	for (const key of root.attrKeys()) {
		const rowId = key as string;
		if (hasRow(root, rowId)) ids.push(rowId);
	}
	return ids.sort();
}

/**
 * Write fields into one row, minting the row if the table holds none there.
 *
 * Caller-supplied fields only: an absent key is left alone rather than being
 * filled from a declared default, because a default is applied at read time and
 * is never written (ADR-0213). Must run inside a `transact`, so a minted row and
 * the fields it admits commit together.
 *
 * There is no revive path and no address to revive. Deletion takes the row's
 * attribute off the root, so a deleted address is indistinguishable from one
 * never used; `create` mints an id nothing has ever held, and `update` refuses
 * an address holding no row. The mint below therefore happens exactly once in a
 * row's life, which is what lets the document container be allocated with it
 * rather than felt for on every write.
 */
export function writeRow(
	root: Y.Type,
	rowId: string,
	fields: JsonObject,
	/**
	 * Roots to allocate inside this row's document, if it is being minted.
	 *
	 * Named by the caller and created with the row, for the same reason the
	 * container itself is: `document(id).get(name)` creates on miss, and a
	 * created nested type is addressed by the operation that made it, so two
	 * devices first-opening one note each mint a type at that key and map LWW
	 * discards one along with everything written into it. Allocating here means
	 * there is exactly one creator and the race cannot be expressed.
	 *
	 * Epicenter learns the NAMES and nothing else. It still never reads inside,
	 * never learns a format, and the type name stays the application's business:
	 * a type's name is inert in `@y/y@14.0.0-rc.24` and does not choose its
	 * behaviour (`evidence/invariants.test.ts`).
	 */
	documentRoots: readonly string[] = [],
): void {
	let row = rowType(root, rowId);
	if (row === undefined) {
		row = new Y.Type();
		root.setAttr(rowId as never, row as never);
		const container = new Y.Type();
		row.setAttr(DOCUMENT_ATTRIBUTE as never, container as never);
		// The roots the caller named, allocated in the same transaction as the
		// row, which is what leaves exactly one creator for each of them.
		for (const name of documentRoots) {
			container.setAttr(name as never, new Y.Type() as never);
		}
	}
	for (const [name, value] of Object.entries(fields)) {
		row.setAttr(name as never, value as never);
	}
}

/**
 * The container holding one row's application-owned roots, or undefined when
 * the table holds no row at this address.
 *
 * A pure read: the container was allocated with the row. Epicenter never looks
 * inside, and the application names its own roots and picks their formats.
 */
export function documentContainer(
	root: Y.Type,
	rowId: string,
): Y.Type | undefined {
	const container = rowType(root, rowId)?.getAttr(
		DOCUMENT_ATTRIBUTE as never,
	) as unknown;
	return container instanceof Y.Type ? container : undefined;
}

/**
 * Take one row off its table. Returns whether there was a row to take.
 *
 * The whole subtree goes with the attribute: every field, and the container the
 * row's document lives in. Deleting a nested type reclaims what is under it
 * (`evidence/invariants.test.ts`), so what remains is one deleted map key,
 * measured at 2.0 items and 44.5 bytes (`evidence/bench/tombstones.ts`).
 *
 * ADR-0212 chose the other model: clear every field and set a reserved
 * `!presence` attribute to `absent`, leaving the container attached to the root
 * forever. It defended the extra cost by claiming that removing the attribute
 * destroys a concurrent edit while clearing converges with the peer's edit
 * retained. `evidence/deletion-model.test.ts` measured that claim and it does
 * not survive: under both models a concurrent delete and edit read identically,
 * both devices converge, and the delete wins whichever side goes first. The
 * retained edit is reachable through no verb here, and it comes back if the
 * address is ever revived, so retention was the worse half rather than the
 * benefit. What it cost was about 8 items and 116 bytes per dead row against
 * 2.0 and 44.5: over twenty recordings a day for a decade, 582,000 items and
 * 451 MB of resident memory against 156,000 and 101 MB, on every device that
 * ever opens the application.
 */
export function deleteRow(root: Y.Type, rowId: string): boolean {
	if (rowType(root, rowId) === undefined) return false;
	root.deleteAttr(rowId);
	return true;
}
