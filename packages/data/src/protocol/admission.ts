import type {
	Change,
	JsonObject,
	JsonValue,
	Record as SyncRecord,
} from './schemas.js';

export const DATA_ADMISSION_LIMITS = {
	qualifiedKeyBytes: 128,
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
const QUALIFIED_KEY =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?){2,}$/;
const RUNTIME_ID = /^[a-z0-9]{24}$/;

export function encodedBytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function encodedJsonBytes(value: unknown): number {
	return encodedBytes(JSON.stringify(value));
}

export function isQualifiedKey(value: string): boolean {
	const bytes = encodedBytes(value);
	return (
		bytes >= 3 &&
		bytes <= DATA_ADMISSION_LIMITS.qualifiedKeyBytes &&
		QUALIFIED_KEY.test(value)
	);
}

export function isRuntimeId(value: string): boolean {
	return RUNTIME_ID.test(value);
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
	if (!isQualifiedKey(change.key)) return false;
	if ('rowId' in change && !isRuntimeId(change.rowId)) return false;
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
		!isQualifiedKey(record.key) ||
		!Number.isSafeInteger(record.changedSequence) ||
		record.changedSequence < 1
	) {
		return false;
	}
	if ('rowId' in record && !isRuntimeId(record.rowId)) return false;
	if (encodedJsonBytes(record) > DATA_ADMISSION_LIMITS.encodedRecordBytes)
		return false;
	return record.kind === 'row'
		? isJsonObject(record.fields)
		: record.kind === 'value'
			? isJsonValue(record.value)
			: true;
}
