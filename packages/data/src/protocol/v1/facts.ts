/** Current authority state for one row address. */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import { isAdmissibleAddress, RowAddressSchema } from './addresses.js';
import {
	canonicalize,
	isCanonicalJson,
	maxNodesForCanonicalBytes,
	utf8ByteLength,
} from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import {
	isAdmissibleFieldKey,
	isJsonObject,
	JsonObjectSchema,
} from './json.js';
import type { ValidatedLimits } from './limits.js';

const CLOSED = { additionalProperties: false } as const;
export const SequenceSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});

const presentFactSchema = Type.Object(
	{
		address: RowAddressSchema,
		sequence: SequenceSchema,
		presence: Type.Literal('present'),
		fields: JsonObjectSchema,
	},
	CLOSED,
);
const absentFactSchema = Type.Object(
	{
		address: RowAddressSchema,
		sequence: SequenceSchema,
		presence: Type.Literal('absent'),
	},
	CLOSED,
);

export const FactSchema = Type.Union([presentFactSchema, absentFactSchema]);
export type Fact = Static<typeof FactSchema>;

export function encodedFactBytes(fact: Fact): number {
	return utf8ByteLength(canonicalize(fact));
}

export function isAdmissibleFact(fact: Fact, limits: ValidatedLimits): boolean {
	if (!isAdmissibleAddress(fact.address, limits)) return false;
	if (
		fact.presence === 'present' &&
		(!isJsonObject(fact.fields, limits) ||
			!Object.keys(fact.fields).every((key) =>
				isAdmissibleFieldKey(key, limits.maxFieldKeyBytes),
			))
	) {
		return false;
	}
	return encodedFactBytes(fact) <= limits.maxEncodedFactBytes;
}

export function parseFact(
	value: unknown,
	limits: ValidatedLimits,
): Result<Fact, ScalarProtocolError> {
	return catchAsInvalid('fact', () =>
		isCanonicalJson(
			value,
			maxNodesForCanonicalBytes(limits.maxEncodedFactBytes),
		) &&
		Value.Check(FactSchema, value) &&
		isAdmissibleFact(value, limits)
			? Ok(structuredClone(value))
			: ScalarProtocolError.Invalid({ boundary: 'fact' }),
	);
}
