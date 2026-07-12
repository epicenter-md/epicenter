import type { JsonValue, Mutation } from './protocol.js';

/** Shared admission ceiling applied before any record-sync storage adapter. */
export const RECORD_SYNC_ADMISSION_LIMITS = {
	identifierBytes: 512,
	schemaIdentityBytes: 64 * 1024,
	mutationsPerPush: 64,
	operationsPerMutation: 128,
	cellsPerOperation: 128,
	jsonDepth: 16,
	encodedMutationBytes: 64 * 1024,
	encodedPushBytes: 768 * 1024,
} as const;

const textEncoder = new TextEncoder();

export function encodedBytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function isBoundedIdentifier(value: string): boolean {
	return (
		value.length > 0 &&
		encodedBytes(value) <= RECORD_SYNC_ADMISSION_LIMITS.identifierBytes
	);
}

export function isBoundedSchemaIdentity(value: string): boolean {
	return (
		value.length > 0 &&
		encodedBytes(value) <= RECORD_SYNC_ADMISSION_LIMITS.schemaIdentityBytes
	);
}

function isBoundedJsonValueAtDepth(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (
		typeof value !== 'object' ||
		depth >= RECORD_SYNC_ADMISSION_LIMITS.jsonDepth ||
		ancestors.has(value)
	)
		return false;
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((child) =>
				isBoundedJsonValueAtDepth(child, depth + 1, ancestors),
			)
		: Object.getPrototypeOf(value) === Object.prototype &&
			Object.values(value).every((child) =>
				isBoundedJsonValueAtDepth(child, depth + 1, ancestors),
			);
	ancestors.delete(value);
	return valid;
}

export function isAdmissibleJsonValue(value: unknown): value is JsonValue {
	return isBoundedJsonValueAtDepth(value, 0, new Set());
}

export function isAdmissibleMutation(mutation: Mutation): boolean {
	if (
		!isBoundedIdentifier(mutation.actorId) ||
		mutation.operations.length >
			RECORD_SYNC_ADMISSION_LIMITS.operationsPerMutation
	)
		return false;
	for (const operation of mutation.operations) {
		if (
			!isBoundedIdentifier(operation.table) ||
			!isBoundedIdentifier(operation.rowId)
		)
			return false;
		if (operation.kind === 'deleteRow') continue;
		const cells = Object.entries(operation.cells);
		if (cells.length > RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation)
			return false;
		for (const [name, value] of cells) {
			if (!isBoundedIdentifier(name) || !isAdmissibleJsonValue(value))
				return false;
		}
	}
	return (
		encodedBytes(JSON.stringify(mutation)) <=
		RECORD_SYNC_ADMISSION_LIMITS.encodedMutationBytes
	);
}
