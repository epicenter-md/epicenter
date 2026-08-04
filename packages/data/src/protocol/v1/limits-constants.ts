import type { ScalarSyncLimits } from './limits.js';

/** Provisional Wave 1 wire ceilings, pending the cross-runtime scale proof. */
export type V1Limits = ScalarSyncLimits;

/**
 * Provisional V1 limits.
 *
 * The two response ceilings sit at 8 MiB, inside the Cloudflare Worker target.
 * Everything else follows from one constraint and one workload fact.
 *
 * The constraint is the settlement inequality `validateLimits` enforces: a
 * submission response carries one current fact AND one possible parked entry
 * for every touched address, so `maxSubmissionAddresses * maxEncodedFactBytes`
 * must leave room under `maxSubmissionResponseBytes`. That fixes the product,
 * not the factors, and the factors are the real choice.
 *
 * The workload fact is that Epicenter is a curated personal universe, not an
 * ingestion lake. ADR-0161's stress target is 1,000,000 final-present addresses
 * totaling 512 MiB, so the representative scalar fact is roughly 512 bytes. A
 * row whose scalar JSON approaches a megabyte is pathological: bulk content
 * belongs in that row's document or its blob, which are separate planes.
 *
 * So batch width is worth more than per-fact headroom here. 64 addresses
 * matches the batch width of the combined exchange this replaces, which keeps
 * round trips flat through the cutover, and 64 KiB per fact is still about 128
 * times the representative fact. Spending the same settlement budget the other
 * way (16 addresses at 256 KiB) would quadruple round trips to buy headroom for
 * facts this product does not intend to store.
 *
 * `maxFieldKeyBytes` and `maxUnsetKeysPerIntent` keep the values the combined
 * exchange already used, so no Lens that admits today stops admitting.
 *
 * These are provisional, and the inequality binds them together: raising
 * `maxSubmissionAddresses` requires lowering `maxEncodedFactBytes`, or raising
 * `maxSubmissionResponseBytes` past what a Worker will return. At batch width
 * 64, 64 KiB is the ceiling; 128 KiB is rejected.
 */
export const V1_LIMITS = {
	jsonDepth: 16,
	propertiesPerObject: 1024,
	maxNamespaceBytes: 128,
	maxTableKeyBytes: 64,
	maxRowIdBytes: 128,
	maxLifetimeBytes: 64,
	maxFieldKeyBytes: 512,
	maxUnsetKeysPerIntent: 128,
	maxEncodedFactBytes: 65536,
	maxFactsResponseBytes: 8388608,
	maxSubmissionBytes: 8388608,
	maxSubmissionResponseBytes: 8388608,
	maxSubmissionAddresses: 64,
} as const satisfies V1Limits;
