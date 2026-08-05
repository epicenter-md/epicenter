/**
 * What a file wants to change, decided per unit against what it was rendered
 * from and what the row says now.
 *
 * The rule this encodes, and the only rule the folder has: hold exactly what you
 * could still push, and show current state everywhere else (ADR-0207). A unit is
 * one scalar field or the body, and all of them take the same three outcomes, so
 * fields and prose behave identically rather than merely resembling each other.
 *
 * The consequence that matters most is the boring one. A unit you did not touch
 * produces nothing, however long the file has been sitting dirty, so a peer's
 * work is never reverted by handing back an accurate picture of a stale world.
 */

import type { JsonObject, JsonValue, TableDefinition } from '@epicenter/lens';

import type { RowClaim } from './parse.js';
import { type TextEdit, textEdits } from './text-edits.js';

/** A row's fields and rendered body, either as last written or as it stands now. */
export type RowState = {
	fields: JsonObject;
	body: string;
};

export type Conflict =
	| {
			kind: 'field';
			field: string;
			base: JsonValue | undefined;
			mine: JsonValue | undefined;
			theirs: JsonValue | undefined;
	  }
	| { kind: 'body' }
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
	body: TextEdit[];
	conflicts: Conflict[];
};

const NOTHING: Omit<PushPlan, 'create' | 'conflicts'> = {
	set: {},
	unset: [],
	body: [],
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
	definition,
}: {
	claim: RowClaim;
	/** What was last written to this file, or undefined if nothing was. */
	base: RowState | undefined;
	/** The row as it stands now, or undefined if there is no such row. */
	theirs: RowState | undefined;
	definition: TableDefinition;
}): PushPlan {
	if (claim.id === undefined) {
		return {
			create: true,
			set: { ...claim.fields },
			unset: [],
			body:
				definition.body === 'text' && claim.body.length > 0
					? [{ at: 0, remove: 0, insert: claim.body }]
					: [],
			conflicts: [],
		};
	}

	if (theirs === undefined) {
		return { create: false, ...NOTHING, conflicts: [{ kind: 'row-vanished' }] };
	}
	if (base === undefined) {
		return { create: false, ...NOTHING, conflicts: [{ kind: 'unbased' }] };
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

	let body: TextEdit[] = [];
	if (definition.body === 'text' && claim.body !== base.body) {
		if (base.body === theirs.body) body = textEdits(base.body, claim.body);
		else conflicts.push({ kind: 'body' });
	}

	return { create: false, set, unset, body, conflicts };
}

/** True when applying this plan would change nothing and report nothing. */
export function isEmptyPlan(plan: PushPlan): boolean {
	return (
		!plan.create &&
		Object.keys(plan.set).length === 0 &&
		plan.unset.length === 0 &&
		plan.body.length === 0 &&
		plan.conflicts.length === 0
	);
}
