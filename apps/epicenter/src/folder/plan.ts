/**
 * What a file wants to change, decided by comparing it to the receipt of what
 * was last written into it.
 *
 * Two inputs, not three. A file says what it currently holds; only the receipt
 * can say what *you* changed. Every field matching the receipt is untouched and
 * is never sent, which is what keeps a stale file from reverting a peer, however
 * long it has been sitting.
 *
 * There is deliberately no comparison against the row as it stands now, and no
 * conflict. Epicenter has no conflict concept anywhere: a write is `{ set,
 * unset }` per field, the authority sequences them, and two devices setting one
 * field resolve by order without asking anyone. A folder is another device
 * (ADR-0207), so it resolves the same way. Stopping to ask here would make this
 * the only place in the system that does.
 */

import { canonicalJson, type JsonObject, type JsonValue } from '@epicenter/lens';

import type { RowClaim } from './parse.js';

export type PushPlan =
	/** No id: mint a row and set everything the file holds. */
	| { kind: 'create'; set: JsonObject }
	/** Send exactly the fields that differ from the receipt. */
	| { kind: 'patch'; set: JsonObject; unset: string[] }
	/**
	 * The file names a row, but no receipt records what was last written into it,
	 * so there is no way to tell your edit from the state it was rendered at.
	 * Pushing would send fields you never touched. Re-rendering the file restores
	 * the receipt and clears this.
	 */
	| { kind: 'unbased' };

/** Field equality, by the canonical form the replica already sorts values into. */
function sameField(left: JsonValue | undefined, right: JsonValue | undefined) {
	if (left === undefined || right === undefined) return left === right;
	return canonicalJson(left) === canonicalJson(right);
}

export function planPush({
	claim,
	base,
}: {
	claim: RowClaim;
	/** The fields last written into this file, or undefined if none were. */
	base: JsonObject | undefined;
}): PushPlan {
	if (claim.id === undefined) {
		return { kind: 'create', set: { ...claim.fields } };
	}
	if (base === undefined) return { kind: 'unbased' };

	const set: JsonObject = {};
	const unset: string[] = [];

	for (const field of new Set([
		...Object.keys(base),
		...Object.keys(claim.fields),
	])) {
		const mine = claim.fields[field];
		if (sameField(mine, base[field])) continue;
		if (mine === undefined) unset.push(field);
		else set[field] = mine;
	}

	return { kind: 'patch', set, unset };
}
