/**
 * Structured scalar addresses: the one canonical way to name a unit of
 * independent convergence (ADR-0160, ADR-0163, ADR-0164).
 *
 * An address is always a structured object, never a flat concatenated string.
 * `kind` answers what is addressed; the remaining coordinates locate it inside a
 * durable namespace. Row and value addresses share a namespace but not a key
 * space, so one namespace may name both a `notes` table and a `notes` value
 * without collision.
 *
 * Namespace, table, and value are durable declarable names that a Lens authors.
 * Only `rowId` is runtime-minted. Renaming any coordinate produces a different
 * address, and therefore a different unit of convergence; there is no rename
 * operation and no alias.
 *
 * Table names and value names have deliberately different grammars, because they
 * are consumed differently (ADR-0162). A table name is mounted as a SQL relation
 * by a trusted inspection host, so it must be a bare SQL identifier and
 * `SELECT * FROM notes` must need no quoting. A value name is never a relation
 * or a column; it is data in the raw value projection, so it may carry dotted
 * grouping such as `settings.sound.manualStart`.
 *
 * Those dots are opaque. They are one durable name, not a path: they imply no
 * nested storage, no wildcard or prefix matching, no inheritance, no namespace
 * boundary, and no extra lifecycle. `settings.sound` and
 * `settings.sound.manualStart` are two unrelated addresses that converge
 * independently, exactly like any other pair (ADR-0164). Nothing may split a
 * value name on `.` to derive meaning. ADR-0176 already refuses the query
 * capabilities that prefix matching would require.
 *
 * Both grammars require a leading letter, which reserves every `_`-prefixed name
 * for internal use.
 */

import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';

import { canonicalJson } from './canonical.js';

const CLOSED = { additionalProperties: false } as const;

/** Reverse-domain namespace: two or more lowercase, dot-separated labels. */
const NAMESPACE_PATTERN =
	'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$';
/** A durable table name: one bare SQL identifier, so a mount needs no quoting. */
const TABLE_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$';
/**
 * A durable value name: one or more identifier segments joined by dots.
 *
 * The pattern admits no empty segment, leading dot, trailing dot, or repeated
 * dot, so the name has exactly one spelling and no reader can mistake a
 * degenerate form for structure.
 */
const VALUE_NAME_PATTERN =
	'^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*$';
/** Runtime-minted 24-character lowercase alphanumeric row id. */
const RUNTIME_ID_PATTERN = '^[a-z0-9]{24}$';

const NAMESPACE = new RegExp(NAMESPACE_PATTERN);
const TABLE_NAME = new RegExp(TABLE_NAME_PATTERN);
const VALUE_NAME = new RegExp(VALUE_NAME_PATTERN);
const RUNTIME_ID = new RegExp(RUNTIME_ID_PATTERN);

/**
 * Byte ceilings for the durable coordinates of an address.
 *
 * Kept as plain numbers rather than a limits object so both the live exchange
 * protocol and the private V1 kernel can bound the same address grammar with
 * their own capacity models.
 */
export type AddressByteCeilings = {
	namespaceBytes: number;
	tableNameBytes: number;
	valueNameBytes: number;
};

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

const namespaceSchema = Type.String({
	minLength: 3,
	pattern: NAMESPACE_PATTERN,
});
const tableNameSchema = Type.String({
	minLength: 1,
	pattern: TABLE_NAME_PATTERN,
});
const valueNameSchema = Type.String({
	minLength: 1,
	pattern: VALUE_NAME_PATTERN,
});
const rowIdSchema = Type.String({
	minLength: 24,
	maxLength: 24,
	pattern: RUNTIME_ID_PATTERN,
});

export const RowAddressSchema = Type.Object(
	{
		kind: Type.Literal('row'),
		namespace: namespaceSchema,
		table: tableNameSchema,
		rowId: rowIdSchema,
	},
	CLOSED,
);
export type RowAddress = Static<typeof RowAddressSchema>;

export const ValueAddressSchema = Type.Object(
	{
		kind: Type.Literal('value'),
		namespace: namespaceSchema,
		value: valueNameSchema,
	},
	CLOSED,
);
export type ValueAddress = Static<typeof ValueAddressSchema>;

export const AddressSchema = Type.Union([RowAddressSchema, ValueAddressSchema]);
export type Address = Static<typeof AddressSchema>;

/**
 * A private, order-stable identity string for one structured address.
 *
 * Internal map keying only: it never reaches storage, the wire, or a URL. The
 * canonical JSON form keeps the identity independent of coordinate insertion
 * order and keeps row and value addresses in disjoint key spaces through the
 * `kind` discriminant. It is deliberately not parseable back into an address:
 * nothing may reconstruct coordinates from a joined string.
 */
export function addressKey(address: Address): string {
	return canonicalJson(address);
}

/** Structured identity equality: equal exactly when every coordinate matches. */
export function addressesEqual(left: Address, right: Address): boolean {
	if (left.kind === 'row') {
		return (
			right.kind === 'row' &&
			left.namespace === right.namespace &&
			left.table === right.table &&
			left.rowId === right.rowId
		);
	}
	return (
		right.kind === 'value' &&
		left.namespace === right.namespace &&
		left.value === right.value
	);
}

/** Whether a durable namespace name is well formed and within its ceiling. */
export function isNamespace(
	value: string,
	ceilings: AddressByteCeilings,
): boolean {
	const bytes = utf8ByteLength(value);
	return (
		bytes >= 3 && bytes <= ceilings.namespaceBytes && NAMESPACE.test(value)
	);
}

/** Whether a durable table name is a bare SQL identifier within its ceiling. */
export function isTableName(
	value: string,
	ceilings: AddressByteCeilings,
): boolean {
	const bytes = utf8ByteLength(value);
	return (
		bytes >= 1 && bytes <= ceilings.tableNameBytes && TABLE_NAME.test(value)
	);
}

/**
 * Whether a durable value name is well formed and within its ceiling.
 *
 * Dotted grouping is admitted here and nowhere else. The dots stay opaque: this
 * function validates the whole name and never splits it into segments a caller
 * could act on.
 */
export function isValueName(
	value: string,
	ceilings: AddressByteCeilings,
): boolean {
	const bytes = utf8ByteLength(value);
	return (
		bytes >= 1 && bytes <= ceilings.valueNameBytes && VALUE_NAME.test(value)
	);
}

/** Whether a runtime-minted row id has the permanent 24-character shape. */
export function isRuntimeId(value: string): boolean {
	return RUNTIME_ID.test(value);
}

/** Semantic byte-length admission for an already structurally valid address. */
export function isAdmissibleAddress(
	address: Address,
	ceilings: AddressByteCeilings,
): boolean {
	if (!isNamespace(address.namespace, ceilings)) return false;
	return address.kind === 'row'
		? isTableName(address.table, ceilings)
		: isValueName(address.value, ceilings);
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
export function isAddress(
	value: unknown,
	ceilings: AddressByteCeilings,
): value is Address {
	return (
		Value.Check(AddressSchema, value) && isAdmissibleAddress(value, ceilings)
	);
}

export function isRowAddress(
	value: unknown,
	ceilings: AddressByteCeilings,
): value is RowAddress {
	return (
		Value.Check(RowAddressSchema, value) && isAdmissibleAddress(value, ceilings)
	);
}

export function isValueAddress(
	value: unknown,
	ceilings: AddressByteCeilings,
): value is ValueAddress {
	return (
		Value.Check(ValueAddressSchema, value) &&
		isAdmissibleAddress(value, ceilings)
	);
}
