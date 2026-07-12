import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	encodedBytes,
	isAdmissibleJsonValue,
	isAdmissibleMutation,
	isBoundedIdentifier,
	isBoundedSchemaIdentity,
	RECORD_SYNC_ADMISSION_LIMITS,
} from './admission.js';

const CLOSED = { additionalProperties: false } as const;
export const RECORD_SYNC_PROTOCOL_MAJOR = 1;
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
	| { [key: string]: JsonValue };
export type Cells = Record<string, JsonValue>;

// The structural schema is deliberately paired with the recursive JSON check
// in the parse functions below. Unsafe supplies the honest static cell type.
const cellsSchema = Type.Unsafe<Cells>(
	Type.Record(Type.String(), Type.Unknown(), {
		maxProperties: RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation,
	}),
);
const envelopeProperties = {
	protocolMajor: positiveSequence,
	schemaIdentity: Type.String({
		minLength: 1,
		maxLength: RECORD_SYNC_ADMISSION_LIMITS.schemaIdentityBytes,
	}),
	databaseIncarnationId: identifier,
};
const mutationProperties = {
	actorId: identifier,
	actorSequence: positiveSequence,
	operations: Type.Array(
		Type.Union([
			Type.Object(
				{
					kind: Type.Literal('createRow'),
					table: identifier,
					rowId: identifier,
					cells: cellsSchema,
				},
				CLOSED,
			),
			Type.Object(
				{
					kind: Type.Literal('updateRow'),
					table: identifier,
					rowId: identifier,
					cells: cellsSchema,
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
		]),
		{
			minItems: 1,
			maxItems: RECORD_SYNC_ADMISSION_LIMITS.operationsPerMutation,
		},
	),
};

export const RequestEnvelopeSchema = Type.Object(envelopeProperties, CLOSED);
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;

export const OperationSchema = mutationProperties.operations.items;
export type Operation = Static<typeof OperationSchema>;

export const MutationSchema = Type.Object(mutationProperties, CLOSED);
export type Mutation = Static<typeof MutationSchema>;

const loggedMutationSchema = Type.Object(
	{ ...mutationProperties, serverSequence: positiveSequence },
	CLOSED,
);
export type LoggedMutation = Static<typeof loggedMutationSchema>;

export const PushRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('push'),
		mutations: Type.Array(MutationSchema, {
			maxItems: RECORD_SYNC_ADMISSION_LIMITS.mutationsPerPush,
		}),
	},
	CLOSED,
);
export type PushRequest = Static<typeof PushRequestSchema>;

export const PullRequestSchema = Type.Object(
	{
		...envelopeProperties,
		kind: Type.Literal('pull'),
		cursor: sequence,
		limit: Type.Integer({ minimum: 1, maximum: 1_000 }),
	},
	CLOSED,
);
export type PullRequest = Static<typeof PullRequestSchema>;

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

// Snapshots carry live rows only: deletion is physical absence, so snapshot
// size follows the live dataset instead of lifetime deletion history.
const snapshotRowSchema = Type.Object(
	{
		table: Type.String({ minLength: 1 }),
		rowId: Type.String({ minLength: 1 }),
		cells: cellsSchema,
	},
	CLOSED,
);
export type SnapshotRow = Static<typeof snapshotRowSchema>;

const snapshotManifestBodyProperties = {
	generation: positiveSequence,
	snapshotSequence: sequence,
	chunkChecksums: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	actorHighWater: Type.Record(Type.String(), sequence),
};
const snapshotManifestBodySchema = Type.Object(
	snapshotManifestBodyProperties,
	CLOSED,
);
export type SnapshotManifestBody = Static<typeof snapshotManifestBodySchema>;

const snapshotManifestSchema = Type.Object(
	{
		...snapshotManifestBodyProperties,
		checksum: Type.String({ minLength: 1 }),
	},
	CLOSED,
);
export type SnapshotManifest = Static<typeof snapshotManifestSchema>;

const snapshotChunkSchema = Type.Object(
	{
		generation: positiveSequence,
		index: sequence,
		rows: Type.Array(snapshotRowSchema),
		checksum: Type.String({ minLength: 1 }),
	},
	CLOSED,
);
export type SnapshotChunk = Static<typeof snapshotChunkSchema>;

const requestRefusalSchema = Type.Union([
	Type.Literal('protocol-mismatch'),
	Type.Literal('schema-identity-mismatch'),
	Type.Literal('database-incarnation-mismatch'),
]);
export type RequestRefusal = Static<typeof requestRefusalSchema>;

export const PushResponseSchema = Type.Union([
	Type.Object({ kind: Type.Literal('push'), ok: Type.Literal(true) }, CLOSED),
	Type.Object(
		{
			kind: Type.Literal('push'),
			ok: Type.Literal(false),
			reason: Type.Union([
				requestRefusalSchema,
				Type.Literal('actor-sequence-gap'),
				// A createRow named a live identity. The whole push rolls back and
				// the actor stays paused; the replica must discard its state and
				// rebootstrap. Never a routine no-op.
				Type.Literal('create-conflict'),
			]),
		},
		CLOSED,
	),
]);
export type PushResponse = Static<typeof PushResponseSchema>;

export const PullResponseSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('pull'),
			ok: Type.Literal(true),
			snapshotRequired: Type.Literal(false),
			fromCursor: sequence,
			mutations: Type.Array(loggedMutationSchema),
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

export const SnapshotChunkResponseSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('snapshotChunk'),
			ok: Type.Literal(true),
			chunk: snapshotChunkSchema,
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

function mutationsAreAdmissible(mutations: Mutation[]): boolean {
	return mutations.every(isAdmissibleMutation);
}

function snapshotRowsHaveJsonCells(rows: SnapshotRow[]): boolean {
	return rows.every(
		(row) =>
			isBoundedIdentifier(row.table) &&
			isBoundedIdentifier(row.rowId) &&
			Object.entries(row.cells).length <=
				RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation &&
			Object.entries(row.cells).every(
				([name, value]) =>
					isBoundedIdentifier(name) && isAdmissibleJsonValue(value),
			),
	);
}

function requestEnvelopeIsAdmissible(value: RequestEnvelope): boolean {
	return (
		isBoundedSchemaIdentity(value.schemaIdentity) &&
		isBoundedIdentifier(value.databaseIncarnationId)
	);
}

export function parseMutation(value: unknown): Mutation {
	if (!Value.Check(MutationSchema, value) || !isAdmissibleMutation(value)) {
		throw new TypeError('Invalid record-sync mutation');
	}
	return value;
}

export function parsePushRequest(value: unknown): PushRequest {
	if (
		!Value.Check(PushRequestSchema, value) ||
		!requestEnvelopeIsAdmissible(value) ||
		!mutationsAreAdmissible(value.mutations) ||
		encodedBytes(JSON.stringify(value)) >
			RECORD_SYNC_ADMISSION_LIMITS.encodedPushBytes
	)
		throw new TypeError('Invalid record-sync push request');
	return value;
}

export function parsePullRequest(value: unknown): PullRequest {
	if (
		!Value.Check(PullRequestSchema, value) ||
		!requestEnvelopeIsAdmissible(value)
	)
		throw new TypeError('Invalid record-sync pull request');
	return value;
}

export function parseSnapshotChunkRequest(
	value: unknown,
): SnapshotChunkRequest {
	if (
		!Value.Check(SnapshotChunkRequestSchema, value) ||
		!requestEnvelopeIsAdmissible(value)
	)
		throw new TypeError('Invalid record-sync snapshot chunk request');
	return value;
}

export function parsePushResponse(value: unknown): PushResponse {
	if (!Value.Check(PushResponseSchema, value))
		throw new TypeError('Invalid record-sync push response');
	return value;
}

export function parsePullResponse(value: unknown): PullResponse {
	if (!Value.Check(PullResponseSchema, value))
		throw new TypeError('Invalid record-sync pull response');
	if (
		value.ok &&
		!value.snapshotRequired &&
		!mutationsAreAdmissible(value.mutations)
	)
		throw new TypeError('Invalid record-sync pull response');
	return value;
}

export function parseSnapshotChunkResponse(
	value: unknown,
): SnapshotChunkResponse {
	if (!Value.Check(SnapshotChunkResponseSchema, value))
		throw new TypeError('Invalid record-sync snapshot chunk response');
	if (value.ok && !snapshotRowsHaveJsonCells(value.chunk.rows))
		throw new TypeError('Invalid record-sync snapshot chunk response');
	return value;
}

export function requestRefusal(
	request: RequestEnvelope,
	expected: RequestEnvelope,
): RequestRefusal | null {
	if (request.protocolMajor !== expected.protocolMajor)
		return 'protocol-mismatch';
	if (request.schemaIdentity !== expected.schemaIdentity)
		return 'schema-identity-mismatch';
	if (request.databaseIncarnationId !== expected.databaseIncarnationId)
		return 'database-incarnation-mismatch';
	return null;
}
