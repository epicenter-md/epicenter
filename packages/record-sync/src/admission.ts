import type {
	JsonValue,
	Mutation,
	Operation,
	SnapshotRow,
} from './protocol.js';

/** Shared admission ceiling applied before any record-sync storage adapter. */
export const RECORD_SYNC_ADMISSION_LIMITS = {
	identifierBytes: 512,
	schemaIdentityBytes: 64 * 1024,
	mutationsPerPush: 64,
	operationsPerMutation: 128,
	cellsPerOperation: 128,
	jsonDepth: 16,
	encodedCellBytes: 256 * 1024,
	// Leaves 4 KiB for snapshot chunk framing under the production 512 KiB cap.
	encodedSnapshotRowBytes: 508 * 1024,
	encodedSnapshotChunkBytes: 512 * 1024,
	encodedMutationBytes: 512 * 1024,
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

/** Bound one logical cell by UTF-8 payload bytes, before JSON framing. */
export function isAdmissibleCellValue(value: unknown): value is JsonValue {
	if (!isAdmissibleJsonValue(value)) return false;
	const encoded = typeof value === 'string' ? value : JSON.stringify(value);
	return encodedBytes(encoded) <= RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes;
}

export function isAdmissibleSnapshotRow(row: SnapshotRow): boolean {
	if (!isBoundedIdentifier(row.table) || !isBoundedIdentifier(row.rowId)) {
		return false;
	}
	const cells = Object.entries(row.cells);
	return (
		cells.length <= RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation &&
		cells.every(
			([name, value]) =>
				isBoundedIdentifier(name) && isAdmissibleCellValue(value),
		) &&
		encodedBytes(JSON.stringify(row)) <=
			RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotRowBytes
	);
}

function isAdmissibleOperation(operation: Operation): boolean {
	if (
		!isBoundedIdentifier(operation.table) ||
		!isBoundedIdentifier(operation.rowId)
	) {
		return false;
	}
	if (operation.kind === 'deleteRow') return true;
	return isAdmissibleSnapshotRow({
		table: operation.table,
		rowId: operation.rowId,
		cells: operation.cells,
	});
}

/**
 * Validate a complete local operation set with conservative mutation-envelope
 * room, so a signed-out write remains encodable after a replica actor is bound.
 */
export function isAdmissibleOperationSet(
	operations: readonly Operation[],
): boolean {
	if (
		operations.length === 0 ||
		operations.length > RECORD_SYNC_ADMISSION_LIMITS.operationsPerMutation ||
		!operations.every(isAdmissibleOperation)
	) {
		return false;
	}
	const mutationWithMaximumActor: Mutation = {
		// NUL is one UTF-8 byte but six JSON bytes, the worst valid identifier
		// framing admitted by the byte-only identifier policy.
		actorId: '\0'.repeat(RECORD_SYNC_ADMISSION_LIMITS.identifierBytes),
		actorSequence: Number.MAX_SAFE_INTEGER,
		operations: [...operations],
	};
	return (
		encodedBytes(JSON.stringify(mutationWithMaximumActor)) <=
		RECORD_SYNC_ADMISSION_LIMITS.encodedMutationBytes
	);
}

export function isAdmissibleMutation(mutation: Mutation): boolean {
	if (
		!isBoundedIdentifier(mutation.actorId) ||
		mutation.operations.length === 0 ||
		mutation.operations.length >
			RECORD_SYNC_ADMISSION_LIMITS.operationsPerMutation
	)
		return false;
	if (!mutation.operations.every(isAdmissibleOperation)) return false;
	const canonicalMutation: Mutation = {
		actorId: mutation.actorId,
		actorSequence: mutation.actorSequence,
		operations: mutation.operations,
	};
	return (
		encodedBytes(JSON.stringify(canonicalMutation)) <=
		RECORD_SYNC_ADMISSION_LIMITS.encodedMutationBytes
	);
}
