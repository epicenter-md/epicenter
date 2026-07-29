/**
 * The kernel's view of structured scalar addresses (ADR-0160, ADR-0163).
 *
 * The address shape, grammar, identity, and equality have exactly one owner:
 * `@epicenter/lens`. This module adds only what the kernel needs on top of that
 * owner: a parse that enforces the kernel's defensive canonical-JSON shape check
 * and reports the kernel's own `ScalarProtocolError`, bounded by the kernel's
 * `ValidatedLimits` rather than the live exchange protocol's ceilings.
 *
 * Byte-length ceilings stay parametric (see `ScalarSyncLimits`). All address
 * patterns are ASCII, so a lone UTF-16 surrogate can never appear in a
 * coordinate.
 */

import {
	type Address,
	AddressSchema,
	isAdmissibleAddress as isAdmissibleAddressWithin,
} from '@epicenter/lens';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import { isCanonicalJson } from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import type { ValidatedLimits } from './limits.js';

export {
	type Address,
	AddressSchema,
	addressesEqual,
	addressKey,
	type RowAddress,
	RowAddressSchema,
	type ValueAddress,
	ValueAddressSchema,
} from '@epicenter/lens';

/** Semantic byte-length admission for an already structurally valid address. */
export function isAdmissibleAddress(
	address: Address,
	limits: ValidatedLimits,
): boolean {
	// The kernel's limits already carry one ceiling per coordinate kind, which is
	// what the shared owner now expects, so this maps across without a branch.
	return isAdmissibleAddressWithin(address, {
		namespaceBytes: limits.maxNamespaceBytes,
		tableNameBytes: limits.maxTableKeyBytes,
		valueNameBytes: limits.maxValueKeyBytes,
	});
}

export function parseAddress(
	value: unknown,
	limits: ValidatedLimits,
): Result<Address, ScalarProtocolError> {
	return catchAsInvalid('address', () =>
		// One object plus the maximum four leaf coordinates of a row address.
		isCanonicalJson(value, 5) &&
		Value.Check(AddressSchema, value) &&
		isAdmissibleAddress(value, limits)
			? Ok(structuredClone(value))
			: ScalarProtocolError.Invalid({ boundary: 'address' }),
	);
}
