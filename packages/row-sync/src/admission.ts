import type { JsonObject, JsonValue, WireRowIntent } from './protocol.js';

/**
 * Shared ceilings applied before any row-sync storage adapter.
 */
export const ROW_SYNC_ADMISSION_LIMITS = {
	identifierBytes: 512,
	/** Public row ids are exactly 24 lowercase alphanumerics (ADR-0130). */
	rowIdLength: 24,
	intentsPerRound: 64,
	pullEntriesPerPage: 64,
	acquiredRowsPerPage: 64,
	unsetKeysPerIntent: 128,
	jsonDepth: 16,
	propertiesPerObject: 1_024,
	/** One row's complete encoded field postimage. */
	encodedRowBytes: 508 * 1024,
	/** The reserved KV row's aggregate cap (ADR-0132). */
	encodedKvAggregateBytes: 64 * 1024,
	/** One encoded RowIntent on the JSON wire. */
	encodedIntentBytes: 700 * 1024,
	encodedRoundBytes: 768 * 1024,
	encodedPageBytes: 8 * 1024 * 1024,
} as const;

/**
 * The one runtime-reserved row address: the workspace KV aggregate
 * (ADR-0132). Only field-bearing `update` intents are admissible here; the
 * fold treats absence as `{}`. Every other `__epicenter_`-prefixed table is
 * runtime vocabulary and refuses application rows entirely.
 */
export const RESERVED_KV_TABLE = '__epicenter_kv';
export const RESERVED_KV_ROW_ID = 'workspace';
const RESERVED_TABLE_PREFIX = '__epicenter_';

export function isReservedKvAddress(table: string, rowId: string): boolean {
	return table === RESERVED_KV_TABLE && rowId === RESERVED_KV_ROW_ID;
}

const ROW_ID = /^[a-z0-9]{24}$/;

/** The exact public row-id shape; the reserved KV address is the exception. */
export function isCanonicalRowId(rowId: string): boolean {
	return ROW_ID.test(rowId);
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
		encodedBytes(value) <= ROW_SYNC_ADMISSION_LIMITS.identifierBytes
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
		depth >= ROW_SYNC_ADMISSION_LIMITS.jsonDepth ||
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
				ROW_SYNC_ADMISSION_LIMITS.propertiesPerObject &&
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
	fields,
}: {
	table: string;
	rowId: string;
	fields: JsonObject;
}): boolean {
	return (
		isBoundedIdentifier(table) &&
		isBoundedIdentifier(rowId) &&
		isAdmissibleJsonObject(fields) &&
		encodedJsonBytes({
			table,
			rowId,
			fields,
			sequence: Number.MAX_SAFE_INTEGER,
		}) <= ROW_SYNC_ADMISSION_LIMITS.encodedRowBytes
	);
}

/** Validate one intent's address: table namespace plus row-id shape. */
function isAdmissibleAddress(intent: WireRowIntent): boolean {
	if (
		!isBoundedIdentifier(intent.table) ||
		!isBoundedIdentifier(intent.rowId)
	) {
		return false;
	}
	if (intent.table.startsWith(RESERVED_TABLE_PREFIX)) {
		// The reserved KV row accepts only field-bearing updates (ADR-0132).
		return (
			isReservedKvAddress(intent.table, intent.rowId) &&
			intent.kind === 'update'
		);
	}
	return isCanonicalRowId(intent.rowId);
}

export function isAdmissibleIntent(intent: WireRowIntent): boolean {
	if (!isAdmissibleAddress(intent)) return false;
	if (encodedJsonBytes(intent) > ROW_SYNC_ADMISSION_LIMITS.encodedIntentBytes) {
		return false;
	}
	switch (intent.kind) {
		case 'create':
			return isAdmissibleJsonObject(intent.fields);
		case 'update': {
			const { set, unset } = intent.fields;
			if (!isAdmissibleJsonObject(set)) return false;
			if (Object.keys(set).length === 0 && unset.length === 0) return false;
			const unsetKeys = new Set(unset);
			return (
				unsetKeys.size === unset.length &&
				unset.every(isBoundedIdentifier) &&
				Object.keys(set).every(
					(key) => isBoundedIdentifier(key) && !unsetKeys.has(key),
				)
			);
		}
		case 'delete':
			return true;
	}
}
