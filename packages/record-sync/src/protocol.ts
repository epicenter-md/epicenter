import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	encodedJsonBytes,
	isAdmissibleCommand,
	isAdmissibleSnapshotRow,
	isAdmissibleStateEntry,
	isBoundedIdentifier,
	RECORD_SYNC_ADMISSION_LIMITS,
} from './admission.js';

const CLOSED = { additionalProperties: false } as const;

/** Increment only for an incompatible wire change. */
export const RECORD_SYNC_PROTOCOL_MAJOR = 4;

const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveSequence = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});
const identifier = Type.String({
	minLength: 1,
	maxLength: RECORD_SYNC_ADMISSION_LIMITS.identifierBytes,
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

const commandSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('createRow'),
			table: identifier,
			rowId: identifier,
			value: jsonObjectSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('patchRow'),
			table: identifier,
			rowId: identifier,
			set: jsonObjectSchema,
			unset: Type.Array(identifier, {
				maxItems: RECORD_SYNC_ADMISSION_LIMITS.unsetKeysPerCommand,
			}),
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('deleteRow'),
			table: identifier,
			rowId: identifier,
		},
		CLOSED,
	),
]);

export type RecordCommand = Static<typeof commandSchema>;

export const MutationSchema = Type.Object(
	{
		actorSequence: positiveSequence,
		command: commandSchema,
	},
	CLOSED,
);
export type Mutation = Static<typeof MutationSchema>;

const envelopeProperties = { protocolMajor: positiveSequence };

export const RequestEnvelopeSchema = Type.Object(envelopeProperties, CLOSED);
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;

export const PushRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('push'),
		actorId: identifier,
		mutations: Type.Array(MutationSchema, {
			minItems: 1,
			maxItems: RECORD_SYNC_ADMISSION_LIMITS.mutationsPerPush,
		}),
	},
	CLOSED,
);
export type PushRequest = Static<typeof PushRequestSchema>;

export type PushReceipt = {
	actorId: string;
	batchChecksum: string;
	firstActorSequence: number;
	lastActorSequence: number;
	firstServerSequence: number;
	lastServerSequence: number;
};

const pushReceiptSchema = Type.Object(
	{
		actorId: identifier,
		batchChecksum: Type.String({ minLength: 1, maxLength: 128 }),
		firstActorSequence: positiveSequence,
		lastActorSequence: positiveSequence,
		firstServerSequence: positiveSequence,
		lastServerSequence: positiveSequence,
	},
	CLOSED,
);

const requestRefusalSchema = Type.Literal('protocol-mismatch');
export type RequestRefusal = Static<typeof requestRefusalSchema>;

export const PushResponseSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('push'),
			ok: Type.Literal(true),
			acceptance: Type.Union([Type.Literal('accepted'), Type.Literal('retry')]),
			receipt: pushReceiptSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('push'),
			ok: Type.Literal(false),
			reason: Type.Union([
				requestRefusalSchema,
				Type.Literal('actor-fork'),
				Type.Literal('actor-sequence-gap'),
				Type.Literal('create-conflict'),
				Type.Literal('row-too-large'),
			]),
		},
		CLOSED,
	),
]);
export type PushResponse = Static<typeof PushResponseSchema>;

const rowStateSchema = Type.Object(
	{
		kind: Type.Literal('row'),
		table: identifier,
		rowId: identifier,
		value: jsonObjectSchema,
		lastServerSequence: positiveSequence,
	},
	CLOSED,
);
const deletionStateSchema = Type.Object(
	{
		kind: Type.Literal('deletion'),
		table: identifier,
		rowId: identifier,
		lastServerSequence: positiveSequence,
	},
	CLOSED,
);
export const StateEntrySchema = Type.Union([
	rowStateSchema,
	deletionStateSchema,
]);
export type StateEntry = Static<typeof StateEntrySchema>;

export const PullRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('pull'),
		cursor: sequence,
		limit: Type.Integer({
			minimum: 1,
			maximum: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull,
		}),
	},
	CLOSED,
);
export type PullRequest = Static<typeof PullRequestSchema>;

const snapshotManifestSchema = Type.Object(
	{
		generation: positiveSequence,
		head: sequence,
		chunkChecksums: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
		}),
		actorHighWater: Type.Record(Type.String(), sequence),
		checksum: Type.String({ minLength: 1 }),
	},
	CLOSED,
);
export type SnapshotManifest = Static<typeof snapshotManifestSchema>;
export type SnapshotManifestBody = Omit<SnapshotManifest, 'checksum'>;

export const PullResponseSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('pull'),
			ok: Type.Literal(true),
			snapshotRequired: Type.Literal(false),
			fromCursor: sequence,
			entries: Type.Array(StateEntrySchema, {
				maxItems: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull,
			}),
			newCursor: sequence,
			hasMore: Type.Boolean(),
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('pull'),
			ok: Type.Literal(true),
			snapshotRequired: Type.Literal(true),
			manifest: snapshotManifestSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('pull'),
			ok: Type.Literal(false),
			reason: requestRefusalSchema,
		},
		CLOSED,
	),
]);
export type PullResponse = Static<typeof PullResponseSchema>;

export type SnapshotRow = {
	table: string;
	rowId: string;
	value: JsonObject;
	lastServerSequence: number;
};

const snapshotRowSchema = Type.Object(
	{
		table: identifier,
		rowId: identifier,
		value: jsonObjectSchema,
		lastServerSequence: positiveSequence,
	},
	CLOSED,
);

export const SnapshotChunkSchema = Type.Object(
	{
		generation: positiveSequence,
		index: sequence,
		rows: Type.Array(snapshotRowSchema),
		checksum: Type.String({ minLength: 1 }),
	},
	CLOSED,
);
export type SnapshotChunk = Static<typeof SnapshotChunkSchema>;

export const SnapshotChunkRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('snapshotChunk'),
		generation: positiveSequence,
		index: sequence,
	},
	CLOSED,
);
export type SnapshotChunkRequest = Static<typeof SnapshotChunkRequestSchema>;

export const SnapshotChunkResponseSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('snapshotChunk'),
			ok: Type.Literal(true),
			chunk: SnapshotChunkSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('snapshotChunk'),
			ok: Type.Literal(false),
			reason: Type.Union([
				requestRefusalSchema,
				Type.Literal('snapshot-replaced'),
				Type.Literal('chunk-out-of-range'),
			]),
		},
		CLOSED,
	),
]);
export type SnapshotChunkResponse = Static<typeof SnapshotChunkResponseSchema>;

export function parseMutation(value: unknown): Mutation {
	if (
		!Value.Check(MutationSchema, value) ||
		!isAdmissibleCommand(value.command)
	) {
		throw new TypeError('Invalid record mutation');
	}
	return structuredClone(value);
}

export function parsePushRequest(value: unknown): PushRequest {
	if (
		!Value.Check(PushRequestSchema, value) ||
		!isBoundedIdentifier(value.actorId) ||
		!value.mutations.every((mutation) =>
			isAdmissibleCommand(mutation.command),
		) ||
		encodedJsonBytes(value) > RECORD_SYNC_ADMISSION_LIMITS.encodedPushBytes
	) {
		throw new TypeError('Invalid record push request');
	}
	const first = value.mutations[0];
	if (
		!first ||
		value.mutations.some(
			(mutation, index) =>
				mutation.actorSequence !== first.actorSequence + index,
		)
	) {
		throw new TypeError('Push actor sequences must be contiguous');
	}
	return structuredClone(value);
}

export function parsePullRequest(value: unknown): PullRequest {
	if (!Value.Check(PullRequestSchema, value)) {
		throw new TypeError('Invalid record pull request');
	}
	return structuredClone(value);
}

export function parseSnapshotChunkRequest(
	value: unknown,
): SnapshotChunkRequest {
	if (!Value.Check(SnapshotChunkRequestSchema, value)) {
		throw new TypeError('Invalid snapshot chunk request');
	}
	return structuredClone(value);
}

export function parsePushResponse(value: unknown): PushResponse {
	if (!Value.Check(PushResponseSchema, value)) {
		throw new TypeError('Invalid record push response');
	}
	return structuredClone(value);
}

export function parsePullResponse(value: unknown): PullResponse {
	if (
		!Value.Check(PullResponseSchema, value) ||
		encodedJsonBytes(value) > RECORD_SYNC_ADMISSION_LIMITS.encodedPullBytes ||
		(value.ok &&
			!value.snapshotRequired &&
			!value.entries.every(isAdmissibleStateEntry))
	) {
		throw new TypeError('Invalid record pull response');
	}
	return structuredClone(value);
}

export function parseSnapshotChunk(value: unknown): SnapshotChunk {
	if (
		!Value.Check(SnapshotChunkSchema, value) ||
		!value.rows.every(isAdmissibleSnapshotRow) ||
		encodedJsonBytes(value) >
			RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes
	) {
		throw new TypeError('Invalid snapshot chunk');
	}
	return structuredClone(value);
}

export function parseSnapshotChunkResponse(
	value: unknown,
): SnapshotChunkResponse {
	if (!Value.Check(SnapshotChunkResponseSchema, value)) {
		throw new TypeError('Invalid snapshot chunk response');
	}
	if (value.ok) parseSnapshotChunk(value.chunk);
	return structuredClone(value);
}

export function requestRefusal(
	request: RequestEnvelope,
): RequestRefusal | null {
	return request.protocolMajor === RECORD_SYNC_PROTOCOL_MAJOR
		? null
		: 'protocol-mismatch';
}
