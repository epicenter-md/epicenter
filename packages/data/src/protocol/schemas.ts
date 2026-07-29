import { isJsonValue, type JsonObject, type JsonValue } from '@epicenter/lens';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export type { JsonObject, JsonValue } from '@epicenter/lens';

import {
	isRuntimeId,
	RowAddressSchema,
	ValueAddressSchema,
} from '@epicenter/lens';
import {
	DATA_ADMISSION_LIMITS,
	encodedJsonBytes,
	isAdmissibleFact,
	isAdmissibleIntent,
} from './admission.js';

const CLOSED = { additionalProperties: false } as const;
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveSequence = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});

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

const jsonValueSchema = Type.Unsafe<JsonValue>({});
const jsonObjectSchema = Type.Unsafe<JsonObject>(
	Type.Object({}, { additionalProperties: true }),
);
const fieldKey = Type.String({
	minLength: 1,
	maxLength: DATA_ADMISSION_LIMITS.fieldKeyBytes,
});

/**
 * Intents: what a replica is asking the authority to do at one address.
 *
 * An intent names a verb because it is a command, and a command's whole content
 * is the action. There is deliberately no row `create` verb beside `patch`: a
 * create and an update differ only in what the authority happens to be holding
 * when the intent lands, which is a fact about the authority rather than about
 * what the replica asked for. One `patch` folds over the live row, or over an
 * empty object when the address has no fact at all, and is refused outright once
 * the address carries a tombstone. That keeps row death terminal without a
 * second verb whose only job was to encode "I believe this row is new".
 */
const rowPatchIntentSchema = Type.Object(
	{
		verb: Type.Literal('patch'),
		address: RowAddressSchema,
		set: jsonObjectSchema,
		unset: Type.Array(fieldKey, {
			maxItems: DATA_ADMISSION_LIMITS.unsetKeysPerIntent,
		}),
	},
	CLOSED,
);
const rowDeleteIntentSchema = Type.Object(
	{ verb: Type.Literal('delete'), address: RowAddressSchema },
	CLOSED,
);
const valueSetIntentSchema = Type.Object(
	{
		verb: Type.Literal('set'),
		address: ValueAddressSchema,
		content: jsonValueSchema,
	},
	CLOSED,
);
const valueUnsetIntentSchema = Type.Object(
	{ verb: Type.Literal('unset'), address: ValueAddressSchema },
	CLOSED,
);

export const IntentSchema = Type.Union([
	rowPatchIntentSchema,
	rowDeleteIntentSchema,
	valueSetIntentSchema,
	valueUnsetIntentSchema,
]);
export type Intent = Static<typeof IntentSchema>;

/**
 * Facts: the authority's current state at one address.
 *
 * A fact carries `presence` rather than a verb because it describes a state, not
 * an action: nothing about a stored row says whether it arrived by creation or
 * by update. The two axes stay independent. Address `kind` answers what is
 * addressed and supplies the law, so row absence is a terminal tombstone while
 * value absence is a reversible unset. `presence` answers only whether the
 * address currently exists, which cannot be read off the payload: an empty
 * object is a present row and `null` is a present value.
 *
 * `authoritySequence` is the sequence the authority assigned when this current
 * fact last changed. On the wire it is always positive and globally ordered
 * across both address kinds, which is what lets one exchange page be a single
 * ordered stream. A replica's own optimistic writes are not authority facts and
 * do not appear here; see `LocalFact`.
 */
const rowPresentFactSchema = Type.Object(
	{
		presence: Type.Literal('present'),
		address: RowAddressSchema,
		authoritySequence: positiveSequence,
		fields: jsonObjectSchema,
	},
	CLOSED,
);
const rowAbsentFactSchema = Type.Object(
	{
		presence: Type.Literal('absent'),
		address: RowAddressSchema,
		authoritySequence: positiveSequence,
	},
	CLOSED,
);
const valuePresentFactSchema = Type.Object(
	{
		presence: Type.Literal('present'),
		address: ValueAddressSchema,
		authoritySequence: positiveSequence,
		content: jsonValueSchema,
	},
	CLOSED,
);
const valueAbsentFactSchema = Type.Object(
	{
		presence: Type.Literal('absent'),
		address: ValueAddressSchema,
		authoritySequence: positiveSequence,
	},
	CLOSED,
);

export const FactSchema = Type.Union([
	rowPresentFactSchema,
	rowAbsentFactSchema,
	valuePresentFactSchema,
	valueAbsentFactSchema,
]);
export type Fact = Static<typeof FactSchema>;

/**
 * A replica's current view at one address, which is not always an authority
 * fact.
 *
 * Structurally identical to {@link Fact} except in the one place they genuinely
 * differ: `authoritySequence` may be `0`, meaning "the authority has not
 * assigned one yet". That is what a local optimistic write looks like before an
 * exchange settles it. The two types stay separate so that the wire keeps its
 * real guarantee, a positive globally ordered sequence, instead of relaxing
 * authority admission to accommodate a state only the local replica can be in.
 * `parseFact` refuses a zero sequence, so a local fact can never be published as
 * an authority fact by accident.
 */
export type LocalFact =
	| {
			presence: 'present';
			address: Static<typeof RowAddressSchema>;
			authoritySequence: number;
			fields: JsonObject;
	  }
	| {
			presence: 'absent';
			address: Static<typeof RowAddressSchema>;
			authoritySequence: number;
	  }
	| {
			presence: 'present';
			address: Static<typeof ValueAddressSchema>;
			authoritySequence: number;
			content: JsonValue;
	  }
	| {
			presence: 'absent';
			address: Static<typeof ValueAddressSchema>;
			authoritySequence: number;
	  };

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
		intents: Type.Array(IntentSchema, {
			minItems: 1,
			maxItems: DATA_ADMISSION_LIMITS.intentsPerBatch,
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
		facts: Type.Array(FactSchema, {
			maxItems: DATA_ADMISSION_LIMITS.factsPerPage,
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

export function parseIntent(
	value: unknown,
): Result<Intent, ProtocolValidationError> {
	return Value.Check(IntentSchema, value) && isAdmissibleIntent(value)
		? Ok(structuredClone(value))
		: ProtocolValidationError.Invalid({ boundary: 'intent' });
}

/**
 * Admit one authority fact. A zero `authoritySequence` is refused here: only the
 * local replica can be in that state, and {@link LocalFact} is where it lives.
 */
export function parseFact(
	value: unknown,
): Result<Fact, ProtocolValidationError> {
	return Value.Check(FactSchema, value) && isAdmissibleFact(value)
		? Ok(structuredClone(value))
		: ProtocolValidationError.Invalid({ boundary: 'fact' });
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
			(!value.batch.intents.every(isAdmissibleIntent) ||
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
		!value.facts.every(isAdmissibleFact) ||
		value.facts.some((fact) => fact.authoritySequence > value.through) ||
		value.facts.some((fact, index, facts) => {
			const prior = facts[index - 1];
			return (
				prior !== undefined && fact.authoritySequence <= prior.authoritySequence
			);
		}) ||
		(value.receipt !== undefined &&
			value.receipt.appliedThrough > value.through) ||
		(value.next !== null &&
			(value.facts.length === 0 ||
				value.next.through !== value.through ||
				value.next.position > value.through ||
				value.next.position !== value.facts.at(-1)?.authoritySequence))
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
