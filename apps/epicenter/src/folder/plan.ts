/**
 * What a file wants to change, decided per field against what it was rendered
 * from and what the row says now.
 *
 * The rule this encodes, and the only rule the folder has: hold exactly what you
 * could still push, and show current state everywhere else (ADR-0207). The unit
 * is one field, and the body is one of them, so prose and metadata are not two
 * behaviors that resemble each other. They are the same behavior.
 *
 * The consequence that matters most is the boring one. A field you did not touch
 * produces nothing, however long the file has been sitting dirty, so a peer's
 * work is never reverted by handing back an accurate picture of a stale world.
 */

import type { JsonObject, JsonValue } from '@epicenter/lens';

import type { RowClaim } from './parse.js';

/** A row's fields, either as last written to a file or as they stand now. */
export type RowState = {
	fields: JsonObject;
};

export type Conflict =
	| {
			kind: 'field';
			field: string;
			base: JsonValue | undefined;
			mine: JsonValue | undefined;
			theirs: JsonValue | undefined;
	  }
	/** The file names a row that no longer exists. */
	| { kind: 'row-vanished' }
	/**
	 * The file names a row, but nothing recorded what was last written to it, so
	 * there is no way to tell your edit from the state it was rendered at.
	 * Re-rendering the file restores the base and clears this.
	 */
	| { kind: 'unbased' };

export type PushPlan = {
	/** True when this claim carries no id and is asking for a row to be minted. */
	create: boolean;
	set: JsonObject;
	unset: string[];
	conflicts: Conflict[];
};

function sameJson(
	left: JsonValue | undefined,
	right: JsonValue | undefined,
): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined) return false;
	if (left === null || right === null) return left === right;
	if (typeof left !== 'object' || typeof right !== 'object') return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((item, index) => sameJson(item, right[index]))
		);
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right as JsonObject);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) =>
			sameJson((left as JsonObject)[key], (right as JsonObject)[key]),
		)
	);
}

export function planPush({
	claim,
	base,
	theirs,
}: {
	claim: RowClaim;
	/** What was last written to this file, or undefined if nothing was. */
	base: RowState | undefined;
	/** The row as it stands now, or undefined if there is no such row. */
	theirs: RowState | undefined;
}): PushPlan {
	if (claim.id === undefined) {
		return {
			create: true,
			set: { ...claim.fields },
			unset: [],
			conflicts: [],
		};
	}

	if (theirs === undefined) {
		return {
			create: false,
			set: {},
			unset: [],
			conflicts: [{ kind: 'row-vanished' }],
		};
	}
	if (base === undefined) {
		return {
			create: false,
			set: {},
			unset: [],
			conflicts: [{ kind: 'unbased' }],
		};
	}

	const set: JsonObject = {};
	const unset: string[] = [];
	const conflicts: Conflict[] = [];

	for (const field of new Set([
		...Object.keys(base.fields),
		...Object.keys(claim.fields),
	])) {
		const mine = claim.fields[field];
		const wasMine = base.fields[field];
		if (sameJson(mine, wasMine)) continue;

		const theirValue = theirs.fields[field];
		if (!sameJson(wasMine, theirValue)) {
			conflicts.push({
				kind: 'field',
				field,
				base: wasMine,
				mine,
				theirs: theirValue,
			});
			continue;
		}
		if (mine === undefined) unset.push(field);
		else set[field] = mine;
	}

	return { create: false, set, unset, conflicts };
}

/** True when applying this plan would change nothing and report nothing. */
export function isEmptyPlan(plan: PushPlan): boolean {
	return (
		!plan.create &&
		Object.keys(plan.set).length === 0 &&
		plan.unset.length === 0 &&
		plan.conflicts.length === 0
	);
}
