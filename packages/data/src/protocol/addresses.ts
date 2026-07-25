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
 * The local-key grammar deliberately requires a leading letter, which reserves
 * every `_`-prefixed relation name for internal use and keeps each legal table
 * name usable as a SQL identifier when a trusted inspection host mounts a Lens
 * as logical views (ADR-0162).
 */

import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';

import { canonicalJson } from './canonical.js';

const CLOSED = { additionalProperties: false } as const;

/** Reverse-domain namespace: two or more lowercase, dot-separated labels. */
const NAMESPACE_PATTERN =
	'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$';
/** A durable local table or value name: an identifier starting with a letter. */
const LOCAL_KEY_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$';
/** Runtime-minted 24-character lowercase alphanumeric row id. */
const RUNTIME_ID_PATTERN = '^[a-z0-9]{24}$';

const NAMESPACE = new RegExp(NAMESPACE_PATTERN);
const LOCAL_KEY = new RegExp(LOCAL_KEY_PATTERN);
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
	localKeyBytes: number;
};

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

const namespaceSchema = Type.String({
	minLength: 3,
	pattern: NAMESPACE_PATTERN,
});
const localKeySchema = Type.String({
	minLength: 1,
	pattern: LOCAL_KEY_PATTERN,
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
		table: localKeySchema,
		rowId: rowIdSchema,
	},
	CLOSED,
);
export type RowAddress = Static<typeof RowAddressSchema>;

export const ValueAddressSchema = Type.Object(
	{
		kind: Type.Literal('value'),
		namespace: namespaceSchema,
		value: localKeySchema,
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

/** Whether a durable table or value name is well formed and within its ceiling. */
export function isLocalKey(
	value: string,
	ceilings: AddressByteCeilings,
): boolean {
	const bytes = utf8ByteLength(value);
	return bytes >= 1 && bytes <= ceilings.localKeyBytes && LOCAL_KEY.test(value);
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
		? isLocalKey(address.table, ceilings)
		: isLocalKey(address.value, ceilings);
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
