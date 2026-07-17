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
export const RECORD_SYNC_PROTOCOL_MAJOR = 5;

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
	Type.Object(
		{
			kind: Type.Literal('bodyAppend'),
			table: identifier,
			rowId: identifier,
			/** One opaque CRDT update payload, base64-encoded (ADR-0133). */
			update: Type.String({ minLength: 1 }),
		},
		CLOSED,
	),
]);

export type RecordCommand = Static<typeof commandSchema>;

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
		commands: Type.Array(commandSchema, {
			minItems: 1,
			maxItems: RECORD_SYNC_ADMISSION_LIMITS.commandsPerRound,
		}),
	},
	CLOSED,
);
export type SealedRound = Static<typeof SealedRoundSchema>;

const envelopeProperties = { protocolMajor: positiveSequence };

export const RequestEnvelopeSchema = Type.Object(envelopeProperties, CLOSED);
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;

export const SyncRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('sync'),
		token: SyncTokenSchema,
		sealedRound: Type.Optional(SealedRoundSchema),
		pageLimit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage,
			}),
		),
	},
	CLOSED,
);
export type SyncRequest = Static<typeof SyncRequestSchema>;

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
const bodyUpdateStateSchema = Type.Object(
	{
		kind: Type.Literal('bodyUpdate'),
		table: identifier,
		rowId: identifier,
		update: Type.String({ minLength: 1 }),
		lastServerSequence: positiveSequence,
	},
	CLOSED,
);
export const StateEntrySchema = Type.Union([
	rowStateSchema,
	deletionStateSchema,
	bodyUpdateStateSchema,
]);
export type StateEntry = Static<typeof StateEntrySchema>;

const snapshotManifestSchema = Type.Object(
	{
		generation: positiveSequence,
		head: sequence,
		chunkChecksums: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
		}),
		checksum: Type.String({ minLength: 1 }),
	},
	CLOSED,
);
export type SnapshotManifest = Static<typeof snapshotManifestSchema>;
export type SnapshotManifestBody = Omit<SnapshotManifest, 'checksum'>;

const requestRefusalSchema = Type.Literal('protocol-mismatch');
export type RequestRefusal = Static<typeof requestRefusalSchema>;

export const SyncResponseSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('sync'),
			ok: Type.Literal(true),
			snapshotRequired: Type.Literal(false),
			token: SyncTokenSchema,
			entries: Type.Array(StateEntrySchema, {
				maxItems: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage,
			}),
			hasMore: Type.Boolean(),
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('sync'),
			ok: Type.Literal(true),
			snapshotRequired: Type.Literal(true),
			/** The round (if any) was already folded; store after install. */
			resumeToken: SyncTokenSchema,
			manifest: snapshotManifestSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('sync'),
			ok: Type.Literal(false),
			reason: Type.Union([
				requestRefusalSchema,
				/**
				 * Terminal: a digest mismatch on the accepted round, or a round
				 * number that is neither the accepted round nor its successor
				 * (ADR-0131). Recovery is a fresh replica identity.
				 */
				Type.Literal('replica-fork'),
			]),
		},
		CLOSED,
	),
]);
export type SyncResponse = Static<typeof SyncResponseSchema>;

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

const snapshotBodyUpdateSchema = Type.Object(
	{
		table: identifier,
		rowId: identifier,
		update: Type.String({ minLength: 1 }),
		lastServerSequence: positiveSequence,
	},
	CLOSED,
);
export type SnapshotBodyUpdate = Static<typeof snapshotBodyUpdateSchema>;

export const SnapshotChunkSchema = Type.Object(
	{
		generation: positiveSequence,
		index: sequence,
		rows: Type.Array(snapshotRowSchema),
		bodies: Type.Array(snapshotBodyUpdateSchema),
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

export function parseRecordCommand(value: unknown): RecordCommand {
	if (!Value.Check(commandSchema, value) || !isAdmissibleCommand(value)) {
		throw new TypeError('Invalid record command');
	}
	return structuredClone(value);
}

export function parseSyncRequest(value: unknown): SyncRequest {
	if (
		!Value.Check(SyncRequestSchema, value) ||
		!isBoundedIdentifier(value.token.replicaId) ||
		(value.sealedRound !== undefined &&
			!value.sealedRound.commands.every(isAdmissibleCommand)) ||
		encodedJsonBytes(value) > RECORD_SYNC_ADMISSION_LIMITS.encodedRoundBytes
	) {
		throw new TypeError('Invalid record sync request');
	}
	return structuredClone(value);
}

export function parseSyncResponse(value: unknown): SyncResponse {
	if (
		!Value.Check(SyncResponseSchema, value) ||
		encodedJsonBytes(value) > RECORD_SYNC_ADMISSION_LIMITS.encodedPageBytes ||
		(value.ok &&
			!value.snapshotRequired &&
			!value.entries.every(isAdmissibleStateEntry))
	) {
		throw new TypeError('Invalid record sync response');
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
): RequestRefusal | undefined {
	return request.protocolMajor === RECORD_SYNC_PROTOCOL_MAJOR
		? undefined
		: 'protocol-mismatch';
}
