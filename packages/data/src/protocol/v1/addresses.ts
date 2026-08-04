/**
 * The private V1 adapter for the shared structured row-address vocabulary.
 */
import {
	type RowAddress,
	RowAddressSchema,
	isAdmissibleAddress as isAdmissibleAddressWithin,
} from '@epicenter/lens';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import { isCanonicalJson } from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import type { ValidatedLimits } from './limits.js';

export {
	type RowAddress,
	RowAddressSchema,
	isRowAddress,
	addressesEqual,
	addressKey,
} from '@epicenter/lens';

export function isAdmissibleAddress(
	address: RowAddress,
	limits: ValidatedLimits,
): boolean {
	return isAdmissibleAddressWithin(address, {
		namespaceBytes: limits.maxNamespaceBytes,
		tableNameBytes: limits.maxTableKeyBytes,
		rowIdBytes: limits.maxRowIdBytes,
	});
}

export function parseAddress(
	value: unknown,
	limits: ValidatedLimits,
): Result<RowAddress, ScalarProtocolError> {
	return catchAsInvalid('address', () =>
		isCanonicalJson(value, 5) &&
		Value.Check(RowAddressSchema, value) &&
		isAdmissibleAddress(value, limits)
			? Ok(structuredClone(value))
			: ScalarProtocolError.Invalid({ boundary: 'address' }),
	);
}
