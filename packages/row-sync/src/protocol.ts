import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	encodedJsonBytes,
	isAdmissibleIntent,
	isAdmissibleOutcome,
	isBoundedIdentifier,
	ROW_SYNC_ADMISSION_LIMITS,
} from './admission.js';

const CLOSED = { additionalProperties: false } as const;

/** Increment only for an incompatible wire change. */
export const ROW_SYNC_PROTOCOL_MAJOR = 6;

const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveSequence = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});
const identifier = Type.String({
	minLength: 1,
	maxLength: ROW_SYNC_ADMISSION_LIMITS.identifierBytes,
});

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export type JsonObject = { [key: string]: JsonValue };

const jsonObjectSchema = Type.Unsafe<JsonObject>(
	Type.Object(
		{},
		{
			additionalProperties: true,
		},
	),
);

const fieldChangesSchema = Type.Object(
	{
		set: jsonObjectSchema,
		unset: Type.Array(identifier, {
			maxItems: ROW_SYNC_ADMISSION_LIMITS.unsetKeysPerIntent,
		}),
	},
	CLOSED,
);
export type FieldChanges = Static<typeof fieldChangesSchema>;

/** One opaque CRDT update payload, base64-encoded on the JSON wire. */
const documentUpdateSchema = Type.String({ minLength: 1 });

/**
 * The canonical row mutation on the wire (ADR-0131). The same semantic
 * RowIntent accumulates locally, persists in SQLite, freezes inside a sealed
 * round, crosses the wire, and folds at the authority. `Uint8Array`, SQLite
 * BLOB, and this base64 form are physical encodings of one type.
 */
const intentSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('create'),
			table: identifier,
			rowId: identifier,
			fields: jsonObjectSchema,
			documentUpdate: Type.Optional(documentUpdateSchema),
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('update'),
			table: identifier,
			rowId: identifier,
			fields: Type.Optional(fieldChangesSchema),
			documentUpdate: Type.Optional(documentUpdateSchema),
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('delete'),
			table: identifier,
			rowId: identifier,
		},
		CLOSED,
	),
]);

export type WireRowIntent = Static<typeof intentSchema>;

/** The semantic RowIntent with its document component as raw bytes. */
export type RowIntent =
	| {
			kind: 'create';
			table: string;
			rowId: string;
			fields: JsonObject;
			documentUpdate?: Uint8Array;
	  }
	| {
			kind: 'update';
			table: string;
			rowId: string;
			fields?: FieldChanges;
			documentUpdate?: Uint8Array;
	  }
	| { kind: 'delete'; table: string; rowId: string };

export function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function toWireRowIntent(intent: RowIntent): WireRowIntent {
	if (intent.kind === 'delete') {
		return { kind: 'delete', table: intent.table, rowId: intent.rowId };
	}
	const documentUpdate =
		intent.documentUpdate === undefined
			? undefined
			: encodeBase64(intent.documentUpdate);
	if (intent.kind === 'create') {
		return {
			kind: 'create',
			table: intent.table,
			rowId: intent.rowId,
			fields: structuredClone(intent.fields),
			...(documentUpdate === undefined ? {} : { documentUpdate }),
		};
	}
	return {
		kind: 'update',
		table: intent.table,
		rowId: intent.rowId,
		...(intent.fields === undefined
			? {}
			: { fields: structuredClone(intent.fields) }),
		...(documentUpdate === undefined ? {} : { documentUpdate }),
	};
}

export function fromWireRowIntent(intent: WireRowIntent): RowIntent {
	if (intent.kind === 'delete') {
		return { kind: 'delete', table: intent.table, rowId: intent.rowId };
	}
	const documentUpdate =
		intent.documentUpdate === undefined
			? undefined
			: decodeBase64(intent.documentUpdate);
	if (intent.kind === 'create') {
		return {
			kind: 'create',
			table: intent.table,
			rowId: intent.rowId,
			fields: structuredClone(intent.fields),
			...(documentUpdate === undefined ? {} : { documentUpdate }),
		};
	}
	return {
		kind: 'update',
		table: intent.table,
		rowId: intent.rowId,
		...(intent.fields === undefined
			? {}
			: { fields: structuredClone(intent.fields) }),
		...(documentUpdate === undefined ? {} : { documentUpdate }),
	};
}

/**
 * The replica facts every exchange carries (ADR-0131). The server-minted
 * checkpoint is the only part a conforming client never fabricates; the shape
 * is validated, but clients treat a received token as opaque.
 */
export const SyncTokenSchema = Type.Object(
	{
		replicaId: identifier,
		acceptedRound: sequence,
		checkpoint: sequence,
	},
	CLOSED,
);
export type SyncToken = Static<typeof SyncTokenSchema>;

export const SealedRoundSchema = Type.Object(
	{
		round: positiveSequence,
		requestDigest: Type.String({ minLength: 1, maxLength: 128 }),
		intents: Type.Array(intentSchema, {
			minItems: 1,
			maxItems: ROW_SYNC_ADMISSION_LIMITS.intentsPerRound,
		}),
	},
	CLOSED,
);
export type SealedRound = Static<typeof SealedRoundSchema>;

const envelopeProperties = { protocolMajor: positiveSequence };

export const RequestEnvelopeSchema = Type.Object(envelopeProperties, CLOSED);
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;

export const EnrollRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('enroll'),
	},
	CLOSED,
);
export type EnrollRequest = Static<typeof EnrollRequestSchema>;

export const EnrollResponseSchema = Type.Union([
	Type.Object(
		{
			result: Type.Literal('enrolled'),
			replicaId: identifier,
		},
		CLOSED,
	),
	Type.Object({ result: Type.Literal('protocol-mismatch') }, CLOSED),
	/**
	 * The deployment refused to issue this new storage-producing capability
	 * (ADR-0137). Definitive for this attempt; issuance is decided before the
	 * authority is reached, so no receipt state exists for the caller.
	 */
	Type.Object({ result: Type.Literal('enrollment-refused') }, CLOSED),
]);
export type EnrollResponse = Static<typeof EnrollResponseSchema>;

export const SyncRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('sync'),
		token: SyncTokenSchema,
		sealedRound: Type.Optional(SealedRoundSchema),
		pageLimit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: ROW_SYNC_ADMISSION_LIMITS.outcomesPerPage,
			}),
		),
	},
	CLOSED,
);
export type SyncRequest = Static<typeof SyncRequestSchema>;

/**
 * One composite confirmed outcome per applied RowIntent (ADR-0133): the
 * complete field postimage when fields changed, the opaque document update
 * when the document changed, or both at one authority sequence. Delete is a
 * separate outcome. These are installation facts, never replayed authorship.
 */
const rowOutcomeSchema = Type.Object(
	{
		kind: Type.Literal('row'),
		table: identifier,
		rowId: identifier,
		fields: Type.Optional(jsonObjectSchema),
		documentUpdate: Type.Optional(documentUpdateSchema),
		sequence: positiveSequence,
	},
	CLOSED,
);
const deletionOutcomeSchema = Type.Object(
	{
		kind: Type.Literal('deletion'),
		table: identifier,
		rowId: identifier,
		sequence: positiveSequence,
	},
	CLOSED,
);
export const RowOutcomeSchema = Type.Union([
	rowOutcomeSchema,
	deletionOutcomeSchema,
]);
export type RowOutcome = Static<typeof RowOutcomeSchema>;

/**
 * The synchronization state machine's response states, one flat
 * discriminant. Operational failure (network, parse, storage) is the
 * caller's dimension, carried outside this union.
 */
export const SyncResponseSchema = Type.Union([
	Type.Object(
		{
			result: Type.Literal('page'),
			token: SyncTokenSchema,
			outcomes: Type.Array(RowOutcomeSchema, {
				maxItems: ROW_SYNC_ADMISSION_LIMITS.outcomesPerPage,
			}),
			hasMore: Type.Boolean(),
			/** Every page reports the floor so acquisition can detect races. */
			retentionFloor: sequence,
		},
		CLOSED,
	),
	Type.Object(
		{
			result: Type.Literal('baseline-required'),
			/** The round (if any) was already folded; store after install. */
			token: SyncTokenSchema,
			retentionFloor: sequence,
		},
		CLOSED,
	),
	Type.Object(
		{
			/**
			 * Terminal: a digest mismatch on the accepted round, or a round
			 * number that is neither the accepted round nor its successor
			 * (ADR-0131). Recovery is a fresh replica identity.
			 */
			result: Type.Literal('replica-fork'),
		},
		CLOSED,
	),
	/** Ordinary sync never creates state for an unseen replica id. */
	Type.Object({ result: Type.Literal('unknown-replica') }, CLOSED),
	Type.Object({ result: Type.Literal('protocol-mismatch') }, CLOSED),
]);
export type SyncResponse = Static<typeof SyncResponseSchema>;

/**
 * Stateless baseline-acquisition scan (ADR-0136): complete live rows in
 * stable address order, each carrying its full document composite (compacted
 * baseline plus retained tail). Pages are disposable; the authority stores no
 * scan session, snapshot, or floor pin.
 */
export const BaselineScanRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('baselineScan'),
		after: Type.Optional(
			Type.Object({ table: identifier, rowId: identifier }, CLOSED),
		),
		pageLimit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: ROW_SYNC_ADMISSION_LIMITS.baselineRowsPerPage,
			}),
		),
	},
	CLOSED,
);
export type BaselineScanRequest = Static<typeof BaselineScanRequestSchema>;

const baselineRowSchema = Type.Object(
	{
		table: identifier,
		rowId: identifier,
		fields: jsonObjectSchema,
		document: Type.Optional(
			Type.Object(
				{
					baseline: Type.Optional(documentUpdateSchema),
					updates: Type.Array(documentUpdateSchema),
				},
				CLOSED,
			),
		),
	},
	CLOSED,
);
export type BaselineRow = Static<typeof baselineRowSchema>;

export const BaselineScanResponseSchema = Type.Union([
	Type.Object(
		{
			result: Type.Literal('page'),
			rows: Type.Array(baselineRowSchema, {
				maxItems: ROW_SYNC_ADMISSION_LIMITS.baselineRowsPerPage,
			}),
			/** The authority head observed with this page. */
			head: sequence,
			retentionFloor: sequence,
			hasMore: Type.Boolean(),
		},
		CLOSED,
	),
	Type.Object({ result: Type.Literal('protocol-mismatch') }, CLOSED),
]);
export type BaselineScanResponse = Static<typeof BaselineScanResponseSchema>;

export function parseRowIntent(value: unknown): WireRowIntent {
	if (!Value.Check(intentSchema, value) || !isAdmissibleIntent(value)) {
		throw new TypeError('Invalid row intent');
	}
	return structuredClone(value);
}

export function parseEnrollRequest(value: unknown): EnrollRequest {
	if (!Value.Check(EnrollRequestSchema, value)) {
		throw new TypeError('Invalid row-sync enroll request');
	}
	return structuredClone(value);
}

export function parseEnrollResponse(value: unknown): EnrollResponse {
	if (
		!Value.Check(EnrollResponseSchema, value) ||
		(value.result === 'enrolled' && !isBoundedIdentifier(value.replicaId))
	) {
		throw new TypeError('Invalid row-sync enroll response');
	}
	return structuredClone(value);
}

export function parseSyncRequest(value: unknown): SyncRequest {
	if (
		!Value.Check(SyncRequestSchema, value) ||
		!isBoundedIdentifier(value.token.replicaId) ||
		(value.sealedRound !== undefined &&
			!value.sealedRound.intents.every(isAdmissibleIntent)) ||
		encodedJsonBytes(value) > ROW_SYNC_ADMISSION_LIMITS.encodedRoundBytes
	) {
		throw new TypeError('Invalid row sync request');
	}
	return structuredClone(value);
}

export function parseSyncResponse(value: unknown): SyncResponse {
	if (
		!Value.Check(SyncResponseSchema, value) ||
		encodedJsonBytes(value) > ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes ||
		(value.result === 'page' && !value.outcomes.every(isAdmissibleOutcome))
	) {
		throw new TypeError('Invalid row sync response');
	}
	return structuredClone(value);
}

export function parseBaselineScanRequest(value: unknown): BaselineScanRequest {
	if (
		!Value.Check(BaselineScanRequestSchema, value) ||
		(value.after !== undefined &&
			(!isBoundedIdentifier(value.after.table) ||
				!isBoundedIdentifier(value.after.rowId)))
	) {
		throw new TypeError('Invalid baseline scan request');
	}
	return structuredClone(value);
}

export function parseBaselineScanResponse(
	value: unknown,
): BaselineScanResponse {
	if (
		!Value.Check(BaselineScanResponseSchema, value) ||
		encodedJsonBytes(value) > ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes ||
		(value.result === 'page' &&
			!value.rows.every(
				(row) =>
					isBoundedIdentifier(row.table) && isBoundedIdentifier(row.rowId),
			))
	) {
		throw new TypeError('Invalid baseline scan response');
	}
	return structuredClone(value);
}

const requestRefusalSchema = Type.Literal('protocol-mismatch');
export type RequestRefusal = Static<typeof requestRefusalSchema>;

export function requestRefusal(
	request: RequestEnvelope,
): RequestRefusal | undefined {
	return request.protocolMajor === ROW_SYNC_PROTOCOL_MAJOR
		? undefined
		: 'protocol-mismatch';
}
