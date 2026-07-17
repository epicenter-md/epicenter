import type {
	JsonObject,
	JsonValue,
	RecordCommand,
	SnapshotRow,
	StateEntry,
} from './protocol.js';

/** Shared ceilings applied before any record-sync storage adapter. */
export const RECORD_SYNC_ADMISSION_LIMITS = {
	identifierBytes: 512,
	commandsPerRound: 64,
	stateEntriesPerPage: 64,
	unsetKeysPerCommand: 128,
	jsonDepth: 16,
	propertiesPerObject: 1_024,
	encodedCommandBytes: 256 * 1024,
	encodedRowBytes: 508 * 1024,
	/** The reserved KV record's aggregate cap (ADR-0132). */
	encodedKvAggregateBytes: 64 * 1024,
	encodedSnapshotChunkBytes: 512 * 1024,
	encodedRoundBytes: 768 * 1024,
	encodedPageBytes: 8 * 1024 * 1024,
} as const;

/**
 * The one runtime-reserved record address: the workspace KV aggregate
 * (ADR-0132). `patchRow` here folds from `{}`; row lifecycle is inadmissible.
 */
export const RESERVED_KV_TABLE = '__epicenter_kv';
export const RESERVED_KV_ROW_ID = 'workspace';

export function isReservedKvAddress(table: string, rowId: string): boolean {
	return table === RESERVED_KV_TABLE && rowId === RESERVED_KV_ROW_ID;
}

const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

/** Body update payloads are opaque bytes, but the encoding must decode. */
export function isBase64Payload(value: string): boolean {
	return (
		value.length > 0 && value.length % 4 === 0 && BASE64_PAYLOAD.test(value)
	);
}

const textEncoder = new TextEncoder();

export function encodedBytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function encodedJsonBytes(value: unknown): number {
	return encodedBytes(JSON.stringify(value));
}

export function isBoundedIdentifier(value: string): boolean {
	return (
		value.length > 0 &&
		encodedBytes(value) <= RECORD_SYNC_ADMISSION_LIMITS.identifierBytes
	);
}

function isJsonValueAtDepth(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (
		typeof value !== 'object' ||
		depth >= RECORD_SYNC_ADMISSION_LIMITS.jsonDepth ||
		ancestors.has(value)
	) {
		return false;
	}
	ancestors.add(value);
	const prototype = Object.getPrototypeOf(value);
	const valid = Array.isArray(value)
		? value.every((child) => isJsonValueAtDepth(child, depth + 1, ancestors))
		: (prototype === Object.prototype || prototype === null) &&
			Object.keys(value).length <=
				RECORD_SYNC_ADMISSION_LIMITS.propertiesPerObject &&
			Object.values(value).every((child) =>
				isJsonValueAtDepth(child, depth + 1, ancestors),
			);
	ancestors.delete(value);
	return valid;
}

export function isAdmissibleJsonValue(value: unknown): value is JsonValue {
	return isJsonValueAtDepth(value, 0, new Set());
}

export function isAdmissibleJsonObject(value: unknown): value is JsonObject {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		isAdmissibleJsonValue(value)
	);
}

/**
 * Check one canonical row against the portable aggregate limits that every
 * authority sequence must be able to encode.
 */
export function isAdmissibleCanonicalRow({
	table,
	rowId,
	value,
}: Pick<SnapshotRow, 'table' | 'rowId' | 'value'>): boolean {
	return (
		isBoundedIdentifier(table) &&
		isBoundedIdentifier(rowId) &&
		isAdmissibleJsonObject(value) &&
		encodedJsonBytes({
			table,
			rowId,
			value,
			lastServerSequence: Number.MAX_SAFE_INTEGER,
		}) <= RECORD_SYNC_ADMISSION_LIMITS.encodedRowBytes
	);
}

export function isAdmissibleSnapshotRow(row: SnapshotRow): boolean {
	return (
		Number.isSafeInteger(row.lastServerSequence) &&
		row.lastServerSequence > 0 &&
		isAdmissibleCanonicalRow(row)
	);
}

export function isAdmissibleStateEntry(entry: StateEntry): boolean {
	if (
		!isBoundedIdentifier(entry.table) ||
		!isBoundedIdentifier(entry.rowId) ||
		!Number.isSafeInteger(entry.lastServerSequence) ||
		entry.lastServerSequence < 1
	) {
		return false;
	}
	switch (entry.kind) {
		case 'deletion':
			return true;
		case 'bodyUpdate':
			return (
				isBase64Payload(entry.update) &&
				encodedJsonBytes(entry) <=
					RECORD_SYNC_ADMISSION_LIMITS.encodedCommandBytes
			);
		case 'row':
			return (
				isAdmissibleJsonObject(entry.value) &&
				encodedJsonBytes(entry) <= RECORD_SYNC_ADMISSION_LIMITS.encodedRowBytes
			);
	}
}

export function isAdmissibleCommand(command: RecordCommand): boolean {
	if (
		!isBoundedIdentifier(command.table) ||
		!isBoundedIdentifier(command.rowId)
	) {
		return false;
	}
	const reserved = isReservedKvAddress(command.table, command.rowId);
	switch (command.kind) {
		case 'createRow':
			return (
				!reserved &&
				isAdmissibleJsonObject(command.value) &&
				encodedJsonBytes(command) <=
					RECORD_SYNC_ADMISSION_LIMITS.encodedCommandBytes
			);
		case 'patchRow': {
			if (!isAdmissibleJsonObject(command.set)) return false;
			if (Object.keys(command.set).length === 0 && command.unset.length === 0) {
				return false;
			}
			const unset = new Set(command.unset);
			return (
				unset.size === command.unset.length &&
				command.unset.every(isBoundedIdentifier) &&
				Object.keys(command.set).every(
					(key) => isBoundedIdentifier(key) && !unset.has(key),
				) &&
				encodedJsonBytes(command) <=
					RECORD_SYNC_ADMISSION_LIMITS.encodedCommandBytes
			);
		}
		case 'deleteRow':
			return (
				!reserved &&
				encodedJsonBytes(command) <=
					RECORD_SYNC_ADMISSION_LIMITS.encodedCommandBytes
			);
		case 'bodyAppend':
			return (
				!reserved &&
				isBase64Payload(command.update) &&
				encodedJsonBytes(command) <=
					RECORD_SYNC_ADMISSION_LIMITS.encodedCommandBytes
			);
	}
}
