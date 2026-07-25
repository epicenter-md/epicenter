import {
	type AddressByteCeilings,
	isAdmissibleAddress,
	isRuntimeId,
} from './addresses.js';
import type {
	Change,
	JsonObject,
	JsonValue,
	Record as SyncRecord,
} from './schemas.js';

export const DATA_ADMISSION_LIMITS = {
	/** Byte ceiling for the durable reverse-domain namespace coordinate. */
	namespaceBytes: 128,
	/** Byte ceiling for a durable local table or value name. */
	localKeyBytes: 64,
	rowIdLength: 24,
	replicaIdLength: 24,
	changesPerBatch: 64,
	recordsPerPage: 64,
	unsetKeysPerChange: 128,
	fieldKeyBytes: 512,
	jsonDepth: 16,
	propertiesPerObject: 1_024,
	encodedRecordBytes: 508 * 1024,
	encodedChangeBytes: 700 * 1024,
	encodedBatchBytes: 768 * 1024,
	encodedPageBytes: 8 * 1024 * 1024,
} as const;

const textEncoder = new TextEncoder();

/** The address-coordinate ceilings this protocol admits. */
export const DATA_ADDRESS_CEILINGS: AddressByteCeilings = {
	namespaceBytes: DATA_ADMISSION_LIMITS.namespaceBytes,
	localKeyBytes: DATA_ADMISSION_LIMITS.localKeyBytes,
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

export function isAdmissibleChange(change: Change): boolean {
	if (!isAdmissibleAddress(change.address, DATA_ADDRESS_CEILINGS)) return false;
	if (change.address.kind === 'row' && !isRuntimeId(change.address.rowId))
		return false;
	if (encodedJsonBytes(change) > DATA_ADMISSION_LIMITS.encodedChangeBytes)
		return false;

	switch (change.kind) {
		case 'create':
			return isJsonObject(change.fields);
		case 'update': {
			if (!isJsonObject(change.fields.set)) return false;
			if (
				Object.keys(change.fields.set).length === 0 &&
				change.fields.unset.length === 0
			)
				return false;
			const unset = new Set(change.fields.unset);
			return (
				unset.size === change.fields.unset.length &&
				change.fields.unset.every(isFieldKey) &&
				Object.keys(change.fields.set).every(
					(key) => isFieldKey(key) && !unset.has(key),
				)
			);
		}
		case 'delete':
			return true;
		case 'set':
			return isJsonValue(change.value);
		case 'unset':
			return true;
		default:
			return change satisfies never;
	}
}

export function isAdmissibleRecord(record: SyncRecord): boolean {
	if (
		!isAdmissibleAddress(record.address, DATA_ADDRESS_CEILINGS) ||
		!Number.isSafeInteger(record.changedSequence) ||
		record.changedSequence < 1
	) {
		return false;
	}
	if (record.address.kind === 'row' && !isRuntimeId(record.address.rowId))
		return false;
	if (encodedJsonBytes(record) > DATA_ADMISSION_LIMITS.encodedRecordBytes)
		return false;
	return record.kind === 'row'
		? isJsonObject(record.fields)
		: record.kind === 'value'
			? isJsonValue(record.value)
			: true;
}
