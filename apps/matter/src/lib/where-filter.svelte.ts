/**
 * The page-owned SQL WHERE filter over a vault's mirror.
 *
 * Bundles the three things a filter is, the input (`text`), the result
 * (`matchedFileNames`), and a bad-clause `error`, plus the debounced query into ONE unit, so
 * the page binds `filter.text` and reads `filter.matchedFileNames` instead of carrying three
 * loose `$state`s and an inline effect that a reader has to mentally group. The states
 * still exist (reactive state is always `let $state`); this just gives them an owner and
 * a name.
 *
 * The vault is NOT stored: it is passed to `resolve` at call time. The vault is
 * page-owned, swappable (open another folder reassigns it), and per-route (the `/demo`
 * route runs its own), so there is no singleton to capture and storing one instance would
 * go stale on the next swap. The page drives the filter with
 * `$effect(() => filter.resolve(vault))`: the effect reads the reactive `vault` (and,
 * inside `resolve`, the vault's `read`), so it re-runs when the folder swaps OR its rows
 * change, and `resolve` returns a cleanup that cancels an in-flight query so a newer
 * clause, a data change, or a folder swap never lands a stale result set.
 */

import type { Vault } from './vault.svelte';

/** Let a burst of keystrokes (or rapid external edits) settle before querying the mirror. */
const DEBOUNCE_MS = 200;

export function createWhereFilter() {
	let text = $state('');
	let matchedFileNames = $state<Set<string>>();
	let error = $state<string>();

	/**
	 * Resolve the current clause to matched names against `vault`. Call inside an `$effect`
	 * so the reactive reads (`vault` and, when present, its `read`) are tracked; the
	 * returned cleanup cancels the pending/in-flight query so only the latest run can
	 * assign. `vault` is passed in rather than captured because the page owns it and can
	 * swap it.
	 */
	function resolve(vault: Vault | undefined): (() => void) | void {
		const clause = text.trim();
		if (vault) void vault.read; // re-run when rows change so an edit updates membership
		// No vault or empty clause: there is no filter, so show every row.
		if (!vault || !clause) {
			matchedFileNames = undefined;
			error = undefined;
			return;
		}
		let cancelled = false;
		const handle = setTimeout(async () => {
			const { data, error: failure } = await vault.matchingFileNames(clause);
			if (cancelled) return; // a newer clause, a data change, or a folder swap won
			if (failure) error = failure.message;
			else {
				matchedFileNames = data;
				error = undefined;
			}
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	}

	return {
		resolve,
		/** The WHERE clause, two-way bound to the folder-header input. */
		get text() {
			return text;
		},
		set text(value: string) {
			text = value;
		},
		/** The names the clause matched, or `undefined` when no clause is active. */
		get matchedFileNames() {
			return matchedFileNames;
		},
		/** A bad clause's message; the last good `matchedFileNames` is kept until it parses. */
		get error() {
			return error;
		},
	};
}
