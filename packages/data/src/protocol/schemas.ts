import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	DATA_ADMISSION_LIMITS,
	encodedJsonBytes,
	isAdmissibleChange,
	isAdmissibleRecord,
	isJsonValue,
	isQualifiedKey,
	isRuntimeId,
} from './admission.js';

const CLOSED = { additionalProperties: false } as const;
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveSequence = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});

export const QualifiedKeySchema = Type.String({
	minLength: 3,
	maxLength: DATA_ADMISSION_LIMITS.qualifiedKeyBytes,
	pattern:
		'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?){2,}$',
});
export type QualifiedKey = Static<typeof QualifiedKeySchema>;

export const RowIdSchema = Type.String({
	minLength: 24,
	maxLength: 24,
	pattern: '^[a-z0-9]{24}$',
});
export type RowId = Static<typeof RowIdSchema>;

export const ReplicaIdSchema = Type.String({
	minLength: 24,
	maxLength: 24,
	pattern: '^[a-z0-9]{24}$',
});
export type ReplicaId = Static<typeof ReplicaIdSchema>;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const jsonValueSchema = Type.Unsafe<JsonValue>({});
const jsonObjectSchema = Type.Unsafe<JsonObject>(
	Type.Object({}, { additionalProperties: true }),
);
const fieldKey = Type.String({
	minLength: 1,
	maxLength: DATA_ADMISSION_LIMITS.fieldKeyBytes,
});

const rowCreateSchema = Type.Object(
	{
		kind: Type.Literal('create'),
		key: QualifiedKeySchema,
		rowId: RowIdSchema,
		fields: jsonObjectSchema,
	},
	CLOSED,
);
const rowUpdateSchema = Type.Object(
	{
		kind: Type.Literal('update'),
		key: QualifiedKeySchema,
		rowId: RowIdSchema,
		fields: Type.Object(
			{
				set: jsonObjectSchema,
				unset: Type.Array(fieldKey, {
					maxItems: DATA_ADMISSION_LIMITS.unsetKeysPerChange,
				}),
			},
			CLOSED,
		),
	},
	CLOSED,
);
const rowDeleteSchema = Type.Object(
	{ kind: Type.Literal('delete'), key: QualifiedKeySchema, rowId: RowIdSchema },
	CLOSED,
);
const valueSetSchema = Type.Object(
	{
		kind: Type.Literal('set'),
		key: QualifiedKeySchema,
		value: jsonValueSchema,
	},
	CLOSED,
);
const valueUnsetSchema = Type.Object(
	{ kind: Type.Literal('unset'), key: QualifiedKeySchema },
	CLOSED,
);

export const ChangeSchema = Type.Union([
	rowCreateSchema,
	rowUpdateSchema,
	rowDeleteSchema,
	valueSetSchema,
	valueUnsetSchema,
]);
export type Change = Static<typeof ChangeSchema>;

const rowRecordSchema = Type.Object(
	{
		kind: Type.Literal('row'),
		key: QualifiedKeySchema,
		rowId: RowIdSchema,
		changedSequence: positiveSequence,
		fields: jsonObjectSchema,
	},
	CLOSED,
);
const rowDeletedRecordSchema = Type.Object(
	{
		kind: Type.Literal('row-deleted'),
		key: QualifiedKeySchema,
		rowId: RowIdSchema,
		changedSequence: positiveSequence,
	},
	CLOSED,
);
const valueRecordSchema = Type.Object(
	{
		kind: Type.Literal('value'),
		key: QualifiedKeySchema,
		changedSequence: positiveSequence,
		value: jsonValueSchema,
	},
	CLOSED,
);
const valueUnsetRecordSchema = Type.Object(
	{
		kind: Type.Literal('value-unset'),
		key: QualifiedKeySchema,
		changedSequence: positiveSequence,
	},
	CLOSED,
);

export const RecordSchema = Type.Union([
	rowRecordSchema,
	rowDeletedRecordSchema,
	valueRecordSchema,
	valueUnsetRecordSchema,
]);
export type Record = Static<typeof RecordSchema>;

export const CursorSchema = Type.Object(
	{ through: sequence, position: sequence },
	CLOSED,
);
export type Cursor = Static<typeof CursorSchema>;

export const BatchSchema = Type.Object(
	{
		seq: positiveSequence,
		digest: Type.String({
			minLength: 64,
			maxLength: 64,
			pattern: '^[a-f0-9]{64}$',
		}),
		changes: Type.Array(ChangeSchema, {
			minItems: 1,
			maxItems: DATA_ADMISSION_LIMITS.changesPerBatch,
		}),
	},
	CLOSED,
);
export type Batch = Static<typeof BatchSchema>;

export const ExchangeRequestSchema = Type.Object(
	{
		replicaId: ReplicaIdSchema,
		after: sequence,
		batch: Type.Optional(BatchSchema),
		cursor: Type.Optional(CursorSchema),
	},
	CLOSED,
);
export type ExchangeRequest = Static<typeof ExchangeRequestSchema>;

export const ReceiptSchema = Type.Object(
	{
		seq: positiveSequence,
		digest: Type.String({
			minLength: 64,
			maxLength: 64,
			pattern: '^[a-f0-9]{64}$',
		}),
		appliedThrough: sequence,
	},
	CLOSED,
);
export type Receipt = Static<typeof ReceiptSchema>;

const exchangeSuccessSchema = Type.Object(
	{
		receipt: Type.Optional(ReceiptSchema),
		through: sequence,
		records: Type.Array(RecordSchema, {
			maxItems: DATA_ADMISSION_LIMITS.recordsPerPage,
		}),
		next: Type.Union([CursorSchema, Type.Null()]),
	},
	CLOSED,
);
const batchConflictSchema = Type.Object(
	{ refusal: Type.Literal('batch-conflict') },
	CLOSED,
);
const storageLimitSchema = Type.Object(
	{ refusal: Type.Literal('storage-limit') },
	CLOSED,
);

export const ExchangeResponseSchema = Type.Union([
	exchangeSuccessSchema,
	batchConflictSchema,
	storageLimitSchema,
]);
export type ExchangeResponse = Static<typeof ExchangeResponseSchema>;
export type ExchangeSuccess = Static<typeof exchangeSuccessSchema>;

export const ProtocolValidationError = defineErrors({
	Invalid: ({ boundary }: { boundary: string }) => ({
		message: `Invalid data protocol ${boundary}`,
		boundary,
	}),
});
export type ProtocolValidationError = InferErrors<
	typeof ProtocolValidationError
>;

export function parseQualifiedKey(
	value: unknown,
): Result<QualifiedKey, ProtocolValidationError> {
	return typeof value === 'string' &&
		Value.Check(QualifiedKeySchema, value) &&
		isQualifiedKey(value)
		? Ok(value)
		: ProtocolValidationError.Invalid({ boundary: 'qualified key' });
}

export function parseRowId(
	value: unknown,
): Result<RowId, ProtocolValidationError> {
	return typeof value === 'string' &&
		Value.Check(RowIdSchema, value) &&
		isRuntimeId(value)
		? Ok(value)
		: ProtocolValidationError.Invalid({ boundary: 'row id' });
}

export function parseReplicaId(
	value: unknown,
): Result<ReplicaId, ProtocolValidationError> {
	return typeof value === 'string' &&
		Value.Check(ReplicaIdSchema, value) &&
		isRuntimeId(value)
		? Ok(value)
		: ProtocolValidationError.Invalid({ boundary: 'replica id' });
}

export function parseChange(
	value: unknown,
): Result<Change, ProtocolValidationError> {
	return Value.Check(ChangeSchema, value) && isAdmissibleChange(value)
		? Ok(structuredClone(value))
		: ProtocolValidationError.Invalid({ boundary: 'change' });
}

export function parseRecord(
	value: unknown,
): Result<Record, ProtocolValidationError> {
	return Value.Check(RecordSchema, value) && isAdmissibleRecord(value)
		? Ok(structuredClone(value))
		: ProtocolValidationError.Invalid({ boundary: 'record' });
}

export function parseExchangeRequest(
	value: unknown,
): Result<ExchangeRequest, ProtocolValidationError> {
	if (
		!Value.Check(ExchangeRequestSchema, value) ||
		!isRuntimeId(value.replicaId)
	) {
		return ProtocolValidationError.Invalid({ boundary: 'exchange request' });
	}
	if (
		(value.cursor !== undefined &&
			(value.batch !== undefined ||
				value.cursor.through < value.after ||
				value.cursor.position < value.after ||
				value.cursor.position > value.cursor.through)) ||
		(value.batch !== undefined &&
			(!value.batch.changes.every(isAdmissibleChange) ||
				encodedJsonBytes(value.batch) >
					DATA_ADMISSION_LIMITS.encodedBatchBytes))
	) {
		return ProtocolValidationError.Invalid({ boundary: 'exchange request' });
	}
	return Ok(structuredClone(value));
}

export function parseExchangeResponse(
	value: unknown,
): Result<ExchangeResponse, ProtocolValidationError> {
	if (!Value.Check(ExchangeResponseSchema, value)) {
		return ProtocolValidationError.Invalid({ boundary: 'exchange response' });
	}
	if ('refusal' in value) return Ok(structuredClone(value));
	if (
		encodedJsonBytes(value) > DATA_ADMISSION_LIMITS.encodedPageBytes ||
		!value.records.every(isAdmissibleRecord) ||
		value.records.some((record) => record.changedSequence > value.through) ||
		value.records.some((record, index, records) => {
			const prior = records[index - 1];
			return (
				prior !== undefined && record.changedSequence <= prior.changedSequence
			);
		}) ||
		(value.receipt !== undefined &&
			value.receipt.appliedThrough > value.through) ||
		(value.next !== null &&
			(value.records.length === 0 ||
				value.next.through !== value.through ||
				value.next.position > value.through ||
				value.next.position !== value.records.at(-1)?.changedSequence))
	) {
		return ProtocolValidationError.Invalid({ boundary: 'exchange response' });
	}
	return Ok(structuredClone(value));
}

export function parseJsonValue(
	value: unknown,
): Result<JsonValue, ProtocolValidationError> {
	return isJsonValue(value)
		? Ok(structuredClone(value))
		: ProtocolValidationError.Invalid({ boundary: 'JSON value' });
}
