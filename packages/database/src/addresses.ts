/**
 * The structured row address: the one canonical way to name a unit of
 * independent convergence (ADR-0160, ADR-0164, ADR-0206).
 *
 * An address is always a structured object, never a flat concatenated string,
 * and it is always exactly three coordinates deep: who owns it, what kind of
 * thing it is, which one. Fixed depth is what makes this a coordinate instead of
 * a path, so nothing needs traversal, prefix matching, or globbing to find
 * anything, which is the machinery ADR-0176 refuses.
 *
 * The coordinates are spelled `tableName` and `rowId` rather than `table` and
 * `row`. Each reads as the durable name it is at every call site and cannot be
 * misread as the thing it names, and `table_name` and `row_id` are the matching
 * SQL column names, so one vocabulary spans the typed API, the wire, and
 * storage.
 *
 * A workspace id and table are durable names a workspace declares. A row id comes from
 * whoever knows it: the runtime mints one when nobody does, and an application
 * supplies one when it does (ADR-0206). Renaming any coordinate produces a
 * different address, and therefore a different unit of convergence; there is no
 * rename operation and no alias.
 *
 * A table name is mounted as a SQL relation by a trusted inspection host, so it
 * must be a bare SQL identifier and `SELECT * FROM notes` must need no quoting
 * (ADR-0162). It requires a leading letter, which reserves every `_`-prefixed
 * relation name for internal use.
 */

import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';

import { canonicalJson } from './canonical.js';

const CLOSED = { additionalProperties: false } as const;

/** Reverse-domain workspace id: two or more lowercase, dot-separated labels. */
const WORKSPACE_ID_PATTERN =
	'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$';
/** A durable table name: one bare SQL identifier, so a mount needs no quoting. */
const TABLE_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$';
/**
 * A row id, whether the runtime minted it or an application chose it.
 *
 * Every admitted character is safe verbatim in a URL path segment, because a
 * row's bytes are read through a path built from its address (ADR-0173). The
 * leading character excludes `.`, `-`, and `_`, so no id can be a relative path
 * segment or hide as a dotfile in a store that uses one on disk.
 *
 * The comparison is case-sensitive, matching SQLite's default collation, so
 * `App` and `app` are two ordinary addresses rather than a collision. That is
 * the same treatment durable names get elsewhere: an id is data, not an
 * identifier a SQL parser has to resolve.
 */
const ROW_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

const WORKSPACE_ID = new RegExp(WORKSPACE_ID_PATTERN);
const TABLE_NAME = new RegExp(TABLE_NAME_PATTERN);
const ROW_ID = new RegExp(ROW_ID_PATTERN);

/**
 * The SQLite keywords that cannot be a bare relation name.
 *
 * A table name is mounted as a bare relation by the trusted inspection host, and
 * the promise is that `SELECT * FROM notes` needs no quoting. Some keywords
 * break that promise: `SELECT * FROM order` is a syntax error however carefully
 * the host generated the view. Refusing the name where it is declared is the
 * only point where the author can still fix it; refusing later would mean a
 * workspace that parses cleanly and then cannot be inspected.
 *
 * This is not the full keyword list, and deliberately so. SQLite accepts most of
 * its own keywords as identifiers: `rows`, `key`, `view`, `first`, `range` and
 * eighty-odd others parse fine unquoted, and refusing them would cost real
 * names for no benefit. These are the ones measured to actually fail, so the
 * rule matches the promise exactly rather than approximating it.
 *
 * The set is a property of SQLite's parser, so `addresses.test.ts` re-derives it
 * against the linked SQLite and fails if the two ever disagree. A version that
 * changes the set is then a loud test failure rather than a workspace that silently
 * stops being inspectable.
 */
export const SQLITE_UNUSABLE_AS_RELATION_NAME: readonly string[] = `add all
	alter and as autoincrement between case check collate commit constraint create
	default deferrable delete distinct drop else escape except exists foreign from
	group having if in index insert intersect into is isnull join limit not
	nothing notnull null on or order primary references returning select set table
	then to transaction union unique update using values when where`.split(/\s+/);

const SQLITE_KEYWORDS = new Set(SQLITE_UNUSABLE_AS_RELATION_NAME);

/**
 * Bare relation names Epicenter storage still occupies.
 *
 * Every scalar relation now sits behind a `_replica_` or `_authority_` prefix,
 * which this grammar already makes unreachable because a table name must begin
 * with a letter. The row document relations have not moved yet, so their two
 * bare names are reserved explicitly until they do. The list is expected to
 * shrink to empty, never to grow: the fix for a future collision is to prefix
 * the relation, not to extend this list.
 */
const RESERVED_TABLE_NAMES = new Set([
	'document_updates',
	'document_publication',
	'document_versions',
]);

/**
 * Byte ceilings for the durable coordinates of an address.
 *
 * Kept as plain numbers rather than a limits object so both the live exchange
 * protocol and the private V1 kernel can bound the same address grammar with
 * their own capacity models.
 */
export type AddressByteCeilings = {
	databaseIdBytes: number;
	tableNameBytes: number;
	rowIdBytes: number;
};

/** The address-coordinate ceilings admitted by the public data vocabulary. */
export const DATA_ADDRESS_CEILINGS: AddressByteCeilings = {
	databaseIdBytes: 128,
	tableNameBytes: 64,
	rowIdBytes: 128,
};

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit < 0x80) {
			bytes += 1;
		} else if (codeUnit < 0x800) {
			bytes += 2;
		} else if (
			codeUnit >= 0xd800 &&
			codeUnit <= 0xdbff &&
			index + 1 < value.length
		) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

const databaseIdSchema = Type.String({
	minLength: 3,
	pattern: WORKSPACE_ID_PATTERN,
});
const tableNameSchema = Type.String({
	minLength: 1,
	pattern: TABLE_NAME_PATTERN,
});
const rowIdSchema = Type.String({
	minLength: 1,
	pattern: ROW_ID_PATTERN,
});

export const RowAddressSchema = Type.Object(
	{
		databaseId: databaseIdSchema,
		tableName: tableNameSchema,
		rowId: rowIdSchema,
	},
	CLOSED,
);
export type RowAddress = Static<typeof RowAddressSchema>;

/**
 * A private, order-stable identity string for one structured address.
 *
 * Internal map keying only: it never reaches storage, the wire, or a URL. The
 * canonical JSON form keeps the identity independent of coordinate insertion
 * order. It is deliberately not parseable back into an address: nothing may
 * reconstruct coordinates from a joined string.
 */
export function addressKey(address: RowAddress): string {
	return canonicalJson(address);
}

/** Structured identity equality: equal exactly when every coordinate matches. */
export function addressesEqual(left: RowAddress, right: RowAddress): boolean {
	return (
		left.databaseId === right.databaseId &&
		left.tableName === right.tableName &&
		left.rowId === right.rowId
	);
}

/** Whether a durable workspace id is well formed and within its ceiling. */
export function isDatabaseId(
	value: string,
	ceilings: AddressByteCeilings,
): boolean {
	const bytes = utf8ByteLength(value);
	return (
		bytes >= 3 && bytes <= ceilings.databaseIdBytes && WORKSPACE_ID.test(value)
	);
}

/**
 * Whether a durable table name is usable as a bare SQL relation.
 *
 * Stricter than the character pattern alone, because the pattern is not the
 * whole promise. The promise is that a trusted host can mount this name and
 * write `SELECT * FROM <name>` with no quoting and no collision, so three more
 * things must hold: the name is not a SQLite keyword (case-insensitively), it
 * does not enter SQLite's reserved `sqlite_` space, and it does not collide with
 * a relation Epicenter storage already occupies.
 *
 * The same rule governs a workspace declaration and an address arriving on the
 * wire. One grammar, checked in one place: a name a workspace may not declare is
 * a name no peer may introduce either.
 */
export function isTableName(
	value: string,
	ceilings: AddressByteCeilings,
): boolean {
	const bytes = utf8ByteLength(value);
	if (bytes < 1 || bytes > ceilings.tableNameBytes) return false;
	if (!TABLE_NAME.test(value)) return false;
	const lowercased = value.toLowerCase();
	return (
		!SQLITE_KEYWORDS.has(lowercased) &&
		!lowercased.startsWith('sqlite_') &&
		!RESERVED_TABLE_NAMES.has(lowercased)
	);
}

/**
 * Whether a row id is well formed and within its ceiling.
 *
 * One grammar for both origins. A minted id and a chosen one are the same kind
 * of name, so nothing downstream may branch on which it was (ADR-0206).
 */
export function isRowId(value: string, ceilings: AddressByteCeilings): boolean {
	const bytes = utf8ByteLength(value);
	return bytes >= 1 && bytes <= ceilings.rowIdBytes && ROW_ID.test(value);
}

/** Semantic byte-length admission for an already structurally valid address. */
export function isAdmissibleAddress(
	address: RowAddress,
	ceilings: AddressByteCeilings,
): boolean {
	return (
		isDatabaseId(address.databaseId, ceilings) &&
		isTableName(address.tableName, ceilings) &&
		isRowId(address.rowId, ceilings)
	);
}

/**
 * Structural and semantic admission for an untrusted candidate address.
 *
 * These are predicates rather than parsers on purpose. Every caller is guarding
 * a boundary and then reporting its own domain failure (a replica input error, an
 * HTTP 400), so a dedicated address error variant would carry no information any
 * caller reads, and returning a defensive clone would charge every local read for
 * a copy it discards.
 */
export function isRowAddress(
	value: unknown,
	ceilings: AddressByteCeilings,
): value is RowAddress {
	return (
		Value.Check(RowAddressSchema, value) && isAdmissibleAddress(value, ceilings)
	);
}
