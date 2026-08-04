/** A replica's desired row transition. */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import { isAdmissibleAddress, RowAddressSchema } from './addresses.js';
import { isCanonicalJson, maxNodesForCanonicalBytes } from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import { encodedFactBytes, type Fact } from './facts.js';
import {
	isAdmissibleFieldKey,
	isJsonObject,
	JsonObjectSchema,
} from './json.js';
import type { ValidatedLimits } from './limits.js';

const CLOSED = { additionalProperties: false } as const;
const fieldKeySchema = Type.String({ minLength: 1 });
const presentIntentSchema = Type.Object(
	{
		address: RowAddressSchema,
		presence: Type.Literal('present'),
		set: JsonObjectSchema,
		unset: Type.Array(fieldKeySchema),
	},
	CLOSED,
);
const absentIntentSchema = Type.Object(
	{ address: RowAddressSchema, presence: Type.Literal('absent') },
	CLOSED,
);
export const IntentSchema = Type.Union([presentIntentSchema, absentIntentSchema]);
export type Intent = Static<typeof IntentSchema>;

function factFits(fact: Fact, limits: ValidatedLimits): boolean {
	return encodedFactBytes(fact) <= limits.maxEncodedFactBytes;
}

export function isAdmissibleIntent(
	intent: Intent,
	limits: ValidatedLimits,
): boolean {
	if (!isAdmissibleAddress(intent.address, limits)) return false;
	const sequence = Number.MAX_SAFE_INTEGER;
	if (intent.presence === 'absent')
		return factFits({ address: intent.address, sequence, presence: 'absent' }, limits);
	if (!isJsonObject(intent.set, limits)) return false;
	if (intent.unset.length > limits.maxUnsetKeysPerIntent) return false;
	const unset = new Set(intent.unset);
	return (
		unset.size === intent.unset.length &&
		intent.unset.every((key) => isAdmissibleFieldKey(key, limits.maxFieldKeyBytes)) &&
		Object.keys(intent.set).every(
			(key) => isAdmissibleFieldKey(key, limits.maxFieldKeyBytes) && !unset.has(key),
		) &&
		factFits(
			{ address: intent.address, sequence, presence: 'present', fields: intent.set },
			limits,
		)
	);
}

export function parseIntent(
	value: unknown,
	limits: ValidatedLimits,
): Result<Intent, ScalarProtocolError> {
	return catchAsInvalid('intent', () =>
		isCanonicalJson(
			value,
			Math.min(
				Number.MAX_SAFE_INTEGER,
				maxNodesForCanonicalBytes(limits.maxEncodedFactBytes) +
					1 +
					limits.maxUnsetKeysPerIntent,
			),
		) &&
		Value.Check(IntentSchema, value) &&
		isAdmissibleIntent(value, limits)
			? Ok(structuredClone(value))
			: ScalarProtocolError.Invalid({ boundary: 'intent' }),
	);
}
