import { addressesEqual } from '@epicenter/lens';
import { isAdmissibleFact } from './admission.js';
import type { Intent, JsonObject, LocalFact } from './schemas.js';

export type FoldResult =
	| { kind: 'applied'; fact: LocalFact }
	| { kind: 'noop'; fact: LocalFact | undefined };

/**
 * Accept a candidate only if it would still be admissible at the largest
 * sequence the authority could ever assign it.
 *
 * Checking at `MAX_SAFE_INTEGER` rather than at the candidate's own sequence
 * keeps the answer independent of when the fold runs: a patch that fits today at
 * sequence 5 but would not fit once the sequence grows longer is refused now, so
 * a replica and the authority never disagree about admissibility.
 */
function applyIfAdmissible(
	fact: LocalFact,
	current: LocalFact | undefined,
): FoldResult {
	return isAdmissibleFact({
		...fact,
		authoritySequence: Number.MAX_SAFE_INTEGER,
	})
		? { kind: 'applied', fact }
		: { kind: 'noop', fact: current };
}

/**
 * Fold one intent over the current fact at its address.
 *
 * The three row cases are the whole law. No fact at all means the address has
 * never existed, so a patch creates it. A present fact means the patch merges
 * over live fields. An absent fact is a tombstone, and row death is terminal
 * within one authority lifetime, so every later intent at that address is a
 * noop: nothing resurrects a deleted row, and a patch arriving after a
 * concurrent delete loses regardless of which replica authored it.
 *
 * This is why there is no separate row `create` verb. The distinction a create
 * carried, "I believe this row is new", is exactly the distinction the current
 * fact already answers, and answers more reliably than the replica could.
 *
 * Value absence is the opposite law and is reversible, so `set` applies whether
 * or not the address currently holds a fact.
 */
export function foldIntent(
	current: LocalFact | undefined,
	intent: Intent,
	nextSequence: number,
): FoldResult {
	const existing =
		current !== undefined && addressesEqual(current.address, intent.address)
			? current
			: undefined;

	switch (intent.verb) {
		case 'patch': {
			if (existing?.presence === 'absent') {
				return { kind: 'noop', fact: existing };
			}
			const fields: JsonObject =
				existing !== undefined && 'fields' in existing
					? structuredClone(existing.fields)
					: {};
			for (const [key, value] of Object.entries(intent.set)) {
				Object.defineProperty(fields, key, {
					configurable: true,
					enumerable: true,
					value: structuredClone(value),
					writable: true,
				});
			}
			for (const key of intent.unset) delete fields[key];
			return applyIfAdmissible(
				{
					presence: 'present',
					address: intent.address,
					authoritySequence: nextSequence,
					fields,
				},
				existing,
			);
		}
		case 'delete':
			// Only a live row can die. Deleting an address that never existed, or is
			// already a tombstone, changes nothing.
			return existing !== undefined &&
				existing.presence === 'present' &&
				'fields' in existing
				? applyIfAdmissible(
						{
							presence: 'absent',
							address: intent.address,
							authoritySequence: nextSequence,
						},
						existing,
					)
				: { kind: 'noop', fact: existing };
		case 'set':
			return applyIfAdmissible(
				{
					presence: 'present',
					address: intent.address,
					authoritySequence: nextSequence,
					content: structuredClone(intent.content),
				},
				existing,
			);
		case 'unset':
			return existing !== undefined &&
				existing.presence === 'present' &&
				'content' in existing
				? applyIfAdmissible(
						{
							presence: 'absent',
							address: intent.address,
							authoritySequence: nextSequence,
						},
						existing,
					)
				: { kind: 'noop', fact: existing };
		default:
			return intent satisfies never;
	}
}
