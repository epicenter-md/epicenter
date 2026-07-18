import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	encodedJsonBytes,
	isAdmissibleCanonicalRow,
	isAdmissibleIntent,
	isAdmissibleJsonObject,
	isBoundedIdentifier,
	ROW_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import type { JsonObject, RowIntent } from './protocol.js';

const CLOSED = { additionalProperties: false } as const;

/** The incompatible current-state row-sync wire generation. */
export const CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR = 9;

const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveSequence = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});
const identifier = Type.String({
	minLength: 1,
	maxLength: ROW_SYNC_ADMISSION_LIMITS.identifierBytes,
});
const replicaId = Type.String({
	minLength: 24,
	maxLength: 24,
	pattern: '^[a-z0-9]{24}$',
});
const REPLICA_ID = /^[a-z0-9]{24}$/;
const digest = Type.String({ minLength: 1, maxLength: 128 });
const jsonObject = Type.Unsafe<JsonObject>(
	Type.Object({}, { additionalProperties: true }),
);
const fieldChanges = Type.Object(
	{
		set: jsonObject,
		unset: Type.Array(identifier, {
			maxItems: ROW_SYNC_ADMISSION_LIMITS.unsetKeysPerIntent,
		}),
	},
	CLOSED,
);

/**
 * The current-state protocol keeps RowIntent as its mutation atom. This schema
 * deliberately owns the new wire contract while retaining the established
 * create, update, and delete vocabulary.
 */
export const CurrentStateRowIntentSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('create'),
			table: identifier,
			rowId: identifier,
			fields: jsonObject,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('update'),
			table: identifier,
			rowId: identifier,
			fields: fieldChanges,
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
export type CurrentStateWireRowIntent = Static<
	typeof CurrentStateRowIntentSchema
>;

export function toCurrentStateWireRowIntent(
	intent: RowIntent,
): CurrentStateWireRowIntent {
	if (intent.kind === 'delete') {
		return { kind: 'delete', table: intent.table, rowId: intent.rowId };
	}
	if (intent.kind === 'create') {
		return {
			kind: 'create',
			table: intent.table,
			rowId: intent.rowId,
			fields: structuredClone(intent.fields),
		};
	}
	return {
		kind: 'update',
		table: intent.table,
		rowId: intent.rowId,
		fields: structuredClone(intent.fields),
	};
}

export function fromCurrentStateWireRowIntent(
	intent: CurrentStateWireRowIntent,
): RowIntent {
	if (intent.kind === 'delete') {
		return { kind: 'delete', table: intent.table, rowId: intent.rowId };
	}
	if (intent.kind === 'create') {
		return {
			kind: 'create',
			table: intent.table,
			rowId: intent.rowId,
			fields: structuredClone(intent.fields),
		};
	}
	return {
		kind: 'update',
		table: intent.table,
		rowId: intent.rowId,
		fields: structuredClone(intent.fields),
	};
}

export const RoundReceiptSchema = Type.Object(
	{
		acceptedRound: sequence,
		requestDigest: Type.Union([digest, Type.Null()]),
		appliedThrough: sequence,
	},
	CLOSED,
);
export type RoundReceipt = Static<typeof RoundReceiptSchema>;

const envelopeProperties = { protocolMajor: positiveSequence };

export const CurrentStateRequestEnvelopeSchema = Type.Object(
	envelopeProperties,
	CLOSED,
);
export type CurrentStateRequestEnvelope = Static<
	typeof CurrentStateRequestEnvelopeSchema
>;

function isCurrentStateReplicaId(value: string): boolean {
	return REPLICA_ID.test(value);
}

export const PushRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('push'),
		replicaId,
		round: positiveSequence,
		requestDigest: digest,
		intents: Type.Array(CurrentStateRowIntentSchema, {
			minItems: 1,
			maxItems: ROW_SYNC_ADMISSION_LIMITS.intentsPerRound,
		}),
	},
	CLOSED,
);
export type PushRequest = Static<typeof PushRequestSchema>;

export const PushResponseSchema = Type.Union([
	Type.Object(
		{
			result: Type.Literal('accepted'),
			receipt: RoundReceiptSchema,
		},
		CLOSED,
	),
	Type.Object({ result: Type.Literal('recovery-required') }, CLOSED),
	Type.Object({ result: Type.Literal('storage-limit') }, CLOSED),
	Type.Object({ result: Type.Literal('protocol-mismatch') }, CLOSED),
]);
export type PushResponse = Static<typeof PushResponseSchema>;

const pageLimit = Type.Integer({
	minimum: 1,
	maximum: ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage,
});

export const PullRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('pull'),
		replicaId,
		after: sequence,
		through: Type.Optional(sequence),
		/** Target row-marker count. */
		pageLimit: Type.Optional(pageLimit),
	},
	CLOSED,
);
export type PullRequest = Static<typeof PullRequestSchema>;

const pullRowEntry = Type.Object(
	{
		kind: Type.Literal('row'),
		table: identifier,
		rowId: identifier,
		/** The current scalar postimage may be newer than the fixed pull head. */
		changedSequence: positiveSequence,
		fields: jsonObject,
	},
	CLOSED,
);
const pullDeletedEntry = Type.Object(
	{
		kind: Type.Literal('deleted'),
		table: identifier,
		rowId: identifier,
		/** The current deletion may be newer than the fixed pull head. */
		deletedSequence: positiveSequence,
	},
	CLOSED,
);
export const PullEntrySchema = Type.Union([pullRowEntry, pullDeletedEntry]);
export type PullEntry = Static<typeof PullEntrySchema>;

export const PullResponseSchema = Type.Union([
	Type.Object(
		{
			result: Type.Literal('page'),
			receipt: RoundReceiptSchema,
			/** The authority head fixed by the first page. */
			through: sequence,
			/** The marker position installed by this page. */
			checkpoint: sequence,
			retentionFloor: sequence,
			entries: Type.Array(PullEntrySchema, {
				maxItems: ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage,
			}),
		},
		CLOSED,
	),
	Type.Object(
		{
			result: Type.Literal('acquisition-required'),
			receipt: RoundReceiptSchema,
			retentionFloor: sequence,
		},
		CLOSED,
	),
	Type.Object({ result: Type.Literal('recovery-required') }, CLOSED),
	Type.Object({ result: Type.Literal('protocol-mismatch') }, CLOSED),
]);
export type PullResponse = Static<typeof PullResponseSchema>;

export const RowAddressSchema = Type.Object(
	{ table: identifier, rowId: identifier },
	CLOSED,
);
export type RowAddress = Static<typeof RowAddressSchema>;

export const AcquireRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('acquire'),
		replicaId,
		afterAddress: Type.Optional(RowAddressSchema),
		pageLimit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: ROW_SYNC_ADMISSION_LIMITS.acquiredRowsPerPage,
			}),
		),
	},
	CLOSED,
);
export type AcquireRequest = Static<typeof AcquireRequestSchema>;

export const AcquiredRowSchema = Type.Object(
	{
		table: identifier,
		rowId: identifier,
		fields: jsonObject,
		changedSequence: positiveSequence,
	},
	CLOSED,
);
export type AcquiredRow = Static<typeof AcquiredRowSchema>;

export const AcquireResponseSchema = Type.Union([
	Type.Object(
		{
			result: Type.Literal('page'),
			receipt: RoundReceiptSchema,
			rows: Type.Array(AcquiredRowSchema, {
				maxItems: ROW_SYNC_ADMISSION_LIMITS.acquiredRowsPerPage,
			}),
			/** The authority head observed while reading this stateless page. */
			head: sequence,
			retentionFloor: sequence,
			hasMore: Type.Boolean(),
		},
		CLOSED,
	),
	Type.Object({ result: Type.Literal('recovery-required') }, CLOSED),
	Type.Object({ result: Type.Literal('protocol-mismatch') }, CLOSED),
]);
export type AcquireResponse = Static<typeof AcquireResponseSchema>;

export function parseCurrentStateRowIntent(
	value: unknown,
): CurrentStateWireRowIntent {
	if (
		!Value.Check(CurrentStateRowIntentSchema, value) ||
		!isAdmissibleIntent(value)
	) {
		throw new TypeError('Invalid current-state row intent');
	}
	return structuredClone(value);
}

export function parsePushRequest(value: unknown): PushRequest {
	if (
		!Value.Check(PushRequestSchema, value) ||
		!isCurrentStateReplicaId(value.replicaId) ||
		!value.intents.every(isAdmissibleIntent) ||
		encodedJsonBytes(value) > ROW_SYNC_ADMISSION_LIMITS.encodedRoundBytes
	) {
		throw new TypeError('Invalid row-sync push request');
	}
	return structuredClone(value);
}

export function parsePushResponse(value: unknown): PushResponse {
	if (
		!Value.Check(PushResponseSchema, value) ||
		(value.result === 'accepted' && !isValidReceipt(value.receipt, false))
	) {
		throw new TypeError('Invalid row-sync push response');
	}
	return structuredClone(value);
}

export function parsePullRequest(value: unknown): PullRequest {
	if (
		!Value.Check(PullRequestSchema, value) ||
		!isCurrentStateReplicaId(value.replicaId) ||
		(value.through !== undefined && value.through < value.after)
	) {
		throw new TypeError('Invalid row-sync pull request');
	}
	return structuredClone(value);
}

export function parsePullResponse(value: unknown): PullResponse {
	if (
		!Value.Check(PullResponseSchema, value) ||
		encodedJsonBytes(value) > ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes ||
		!isValidPullResponse(value)
	) {
		throw new TypeError('Invalid row-sync pull response');
	}
	return structuredClone(value);
}

export function parseAcquireRequest(value: unknown): AcquireRequest {
	if (
		!Value.Check(AcquireRequestSchema, value) ||
		!isCurrentStateReplicaId(value.replicaId) ||
		(value.afterAddress !== undefined &&
			(!isBoundedIdentifier(value.afterAddress.table) ||
				!isBoundedIdentifier(value.afterAddress.rowId)))
	) {
		throw new TypeError('Invalid row-sync acquire request');
	}
	return structuredClone(value);
}

export function parseAcquireResponse(value: unknown): AcquireResponse {
	if (
		!Value.Check(AcquireResponseSchema, value) ||
		encodedJsonBytes(value) > ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes ||
		!isValidAcquireResponse(value)
	) {
		throw new TypeError('Invalid row-sync acquire response');
	}
	return structuredClone(value);
}

const requestRefusalSchema = Type.Literal('protocol-mismatch');
export type CurrentStateRequestRefusal = Static<typeof requestRefusalSchema>;

export function currentStateRequestRefusal(
	request: CurrentStateRequestEnvelope,
): CurrentStateRequestRefusal | undefined {
	return request.protocolMajor === CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR
		? undefined
		: 'protocol-mismatch';
}

function isValidReceipt(
	receipt: RoundReceipt,
	permitsRoundZero: boolean,
): boolean {
	if (receipt.acceptedRound === 0) {
		return (
			permitsRoundZero &&
			receipt.requestDigest === null &&
			receipt.appliedThrough === 0
		);
	}
	return receipt.requestDigest !== null && receipt.appliedThrough > 0;
}

function isValidPullResponse(response: PullResponse): boolean {
	if (response.result === 'acquisition-required') {
		return isValidReceipt(response.receipt, true);
	}
	if (response.result !== 'page') return true;
	if (
		!isValidReceipt(response.receipt, true) ||
		response.checkpoint > response.through ||
		response.retentionFloor > response.through
	) {
		return false;
	}
	return response.entries.every((entry) => {
		if (
			!isBoundedIdentifier(entry.table) ||
			!isBoundedIdentifier(entry.rowId)
		) {
			return false;
		}
		if (entry.kind === 'deleted') return true;
		return isAdmissibleCanonicalRow(entry);
	});
}

function isValidAcquireResponse(response: AcquireResponse): boolean {
	if (response.result !== 'page') return true;
	if (
		!isValidReceipt(response.receipt, true) ||
		response.retentionFloor > response.head ||
		response.receipt.appliedThrough > response.head ||
		(response.hasMore && response.rows.length === 0)
	) {
		return false;
	}
	return response.rows.every(
		(row) =>
			isAdmissibleCanonicalRow(row) &&
			isAdmissibleJsonObject(row.fields) &&
			row.changedSequence <= response.head,
	);
}
