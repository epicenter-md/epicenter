import { DATA_ADDRESS_CEILINGS, isAdmissibleAddress, isJsonObject } from '@epicenter/lens';
import type { Fact, Intent } from './schemas.js';

export const DATA_ADMISSION_LIMITS = {
	intentsPerBatch: 64,
	factsPerPage: 64,
	unsetKeysPerIntent: 128,
	fieldKeyBytes: 512,
	jsonDepth: 16,
	propertiesPerObject: 1_024,
	encodedFactBytes: 508 * 1024,
	encodedIntentBytes: 700 * 1024,
	encodedBatchBytes: 768 * 1024,
	encodedPageBytes: 8 * 1024 * 1024,
} as const;

const textEncoder = new TextEncoder();

export function encodedBytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function encodedJsonBytes(value: unknown): number {
	return encodedBytes(JSON.stringify(value));
}

function isFieldKey(value: string): boolean {
	return (
		value.length > 0 &&
		encodedBytes(value) <= DATA_ADMISSION_LIMITS.fieldKeyBytes
	);
}

export function isAdmissibleIntent(intent: Intent): boolean {
	if (!isAdmissibleAddress(intent.address, DATA_ADDRESS_CEILINGS)) return false;
	if (encodedJsonBytes(intent) > DATA_ADMISSION_LIMITS.encodedIntentBytes)
		return false;

	switch (intent.verb) {
		case 'patch': {
			if (!isJsonObject(intent.set)) return false;
			// An empty patch asks for nothing; it would still burn an authority
			// sequence and wake every subscriber, so it is refused at the boundary.
			if (Object.keys(intent.set).length === 0 && intent.unset.length === 0)
				return false;
			const unset = new Set(intent.unset);
			return (
				unset.size === intent.unset.length &&
				intent.unset.every(isFieldKey) &&
				Object.keys(intent.set).every(
					(key) => isFieldKey(key) && !unset.has(key),
				)
			);
		}
		case 'delete':
			return true;
		default:
			return intent satisfies never;
	}
}

/**
 * Admit one authority fact.
 *
 * The positive-sequence check is the boundary between a local optimistic write
 * and an authority fact: a replica stores `0` until an exchange assigns a real
 * sequence, and that state must never reach the wire.
 */
export function isAdmissibleFact(fact: Fact): boolean {
	if (
		!isAdmissibleAddress(fact.address, DATA_ADDRESS_CEILINGS) ||
		!Number.isSafeInteger(fact.authoritySequence) ||
		fact.authoritySequence < 1
	) {
		return false;
	}
	if (encodedJsonBytes(fact) > DATA_ADMISSION_LIMITS.encodedFactBytes)
		return false;
	if (fact.presence === 'absent') return true;
	return isJsonObject(fact.fields);
}
