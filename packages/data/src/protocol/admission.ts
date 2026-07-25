import {
	type AddressByteCeilings,
	isAdmissibleAddress,
	isRuntimeId,
} from './addresses.js';
import type { Fact, Intent, JsonObject, JsonValue } from './schemas.js';

export const DATA_ADMISSION_LIMITS = {
	/** Byte ceiling for the durable reverse-domain namespace coordinate. */
	namespaceBytes: 128,
	/** Byte ceiling for a durable table name, which mounts as a SQL relation. */
	tableNameBytes: 64,
	/** Byte ceiling for a durable value name, which may carry dotted grouping. */
	valueNameBytes: 128,
	rowIdLength: 24,
	replicaIdLength: 24,
	intentsPerBatch: 64,
	factsPerPage: 64,
	unsetKeysPerIntent: 128,
	fieldKeyBytes: 512,
	jsonDepth: 16,
	propertiesPerObject: 1_024,
	encodedFactBytes: 508 * 1024,
	encodedIntentBytes: 700 * 1024,
	encodedBatchBytes: 768 * 1024,
	encodedPageBytes: 8 * 1024 * 1024,
} as const;

const textEncoder = new TextEncoder();

/** The address-coordinate ceilings this protocol admits. */
export const DATA_ADDRESS_CEILINGS: AddressByteCeilings = {
	namespaceBytes: DATA_ADMISSION_LIMITS.namespaceBytes,
	tableNameBytes: DATA_ADMISSION_LIMITS.tableNameBytes,
	valueNameBytes: DATA_ADMISSION_LIMITS.valueNameBytes,
};

export function encodedBytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function encodedJsonBytes(value: unknown): number {
	return encodedBytes(JSON.stringify(value));
}

function isJsonAtDepth(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (
		typeof value !== 'object' ||
		depth >= DATA_ADMISSION_LIMITS.jsonDepth ||
		ancestors.has(value)
	) {
		return false;
	}
	ancestors.add(value);
	const prototype = Object.getPrototypeOf(value);
	const isValid = Array.isArray(value)
		? value.every((child) => isJsonAtDepth(child, depth + 1, ancestors))
		: (prototype === Object.prototype || prototype === null) &&
			Object.keys(value).length <= DATA_ADMISSION_LIMITS.propertiesPerObject &&
			Object.values(value).every((child) =>
				isJsonAtDepth(child, depth + 1, ancestors),
			);
	ancestors.delete(value);
	return isValid;
}

export function isJsonValue(value: unknown): value is JsonValue {
	return isJsonAtDepth(value, 0, new Set());
}

export function isJsonObject(value: unknown): value is JsonObject {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		isJsonValue(value)
	);
}

function isFieldKey(value: string): boolean {
	return (
		value.length > 0 &&
		encodedBytes(value) <= DATA_ADMISSION_LIMITS.fieldKeyBytes
	);
}

export function isAdmissibleIntent(intent: Intent): boolean {
	if (!isAdmissibleAddress(intent.address, DATA_ADDRESS_CEILINGS)) return false;
	if (intent.address.kind === 'row' && !isRuntimeId(intent.address.rowId))
		return false;
	if (encodedJsonBytes(intent) > DATA_ADMISSION_LIMITS.encodedIntentBytes)
		return false;

	switch (intent.verb) {
		case 'patch': {
			if (!isJsonObject(intent.set)) return false;
			// An empty patch asks for nothing; it would still burn an authority
			// sequence and wake every subscriber, so it is refused at the boundary.
			if (Object.keys(intent.set).length === 0 && intent.unset.length === 0)
				return false;
			const unset = new Set(intent.unset);
			return (
				unset.size === intent.unset.length &&
				intent.unset.every(isFieldKey) &&
				Object.keys(intent.set).every(
					(key) => isFieldKey(key) && !unset.has(key),
				)
			);
		}
		case 'delete':
			return true;
		case 'set':
			return isJsonValue(intent.content);
		case 'unset':
			return true;
		default:
			return intent satisfies never;
	}
}

/**
 * Admit one authority fact.
 *
 * The positive-sequence check is the boundary between a local optimistic write
 * and an authority fact: a replica stores `0` until an exchange assigns a real
 * sequence, and that state must never reach the wire.
 */
export function isAdmissibleFact(fact: Fact): boolean {
	if (
		!isAdmissibleAddress(fact.address, DATA_ADDRESS_CEILINGS) ||
		!Number.isSafeInteger(fact.authoritySequence) ||
		fact.authoritySequence < 1
	) {
		return false;
	}
	if (fact.address.kind === 'row' && !isRuntimeId(fact.address.rowId))
		return false;
	if (encodedJsonBytes(fact) > DATA_ADMISSION_LIMITS.encodedFactBytes)
		return false;
	if (fact.presence === 'absent') return true;
	return 'fields' in fact
		? isJsonObject(fact.fields)
		: isJsonValue(fact.content);
}
