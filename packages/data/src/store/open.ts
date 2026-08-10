/**
 * What every opener shares: the namespace claim, and the shape it hands back.
 *
 * A lens names the store it opens (ADR-0229), so an opener takes the lens and
 * derives the location from `lens.namespace` rather than accepting a second
 * name for the same application.
 */
import type { LensJson, LensParseError } from '@epicenter/lens';
import { Err, Ok, type Result } from 'wellcrafted/result';

import { type BoundOf, type Store, StoreError } from './store.js';

/**
 * One opened application: its tables, `kv`, `query`, and the file under `$store`.
 *
 * The file-level verbs live under one reserved key rather than flat beside the
 * tables. `pressure`, `sync`, `stateVector`, `encodeStateSince`, `applyRemote`,
 * `hasUnresolvedDependencies`, `onLocalWork`, `onCommitted` and disposal are
 * about the FILE, and merging them in would reserve nine table names in a
 * namespace whose names come from users. ADR-0213 already reserves `query` for
 * that reason and cites Jazz moving everything under `$jazz` in 0.18.0 after
 * hitting it. One reserved key costs one name instead of nine.
 */
export type Application<TLens, TStore extends Store = Store> = BoundOf<TLens> & {
	/** This application's file: pressure, sync, and disposal. */
	readonly $store: TStore;
};

/**
 * The namespaces this process currently holds open.
 *
 * Two opens of one namespace would be two `Y.Doc`s of one document that cannot
 * see each other's writes, converging through storage under last-writer-wins:
 * work disappears, converged, with no error and nothing to retry. Refusing the
 * second open makes that unreachable rather than something a caller must avoid,
 * which is the move ADR-0216 made against the chosen-id door.
 *
 * A lifecycle here is legitimate under ADR-0203 rather than a platform forming:
 * one file and one document with two claimants is genuinely contended. It holds
 * strings rather than handles, it is process-local, and disposing a store
 * releases its entry.
 */
const openNamespaces = new Set<string>();

/** Claim a namespace for this process, or report who already holds it. */
export function claimNamespace(namespace: string): Result<void, StoreError> {
	if (openNamespaces.has(namespace)) {
		return StoreError.AlreadyOpen({ namespace });
	}
	openNamespaces.add(namespace);
	return Ok(undefined);
}

/** Release a namespace. Idempotent, because disposal is. */
export function releaseNamespace(namespace: string): void {
	openNamespaces.delete(namespace);
}

/**
 * Bind the lens that named this store, and hand back the one object.
 *
 * Every opener ends here, so the shape an application sees is decided once
 * rather than per runtime.
 */
export function bindOpened<const TLens extends LensJson, TStore extends Store>(
	lens: TLens,
	store: TStore,
): Result<Application<TLens, TStore>, LensParseError | StoreError> {
	const { data, error } = store.bind(lens);
	if (error !== null) return Err(error);
	return Ok(
		Object.freeze({ ...data, $store: store }) as Application<TLens, TStore>,
	);
}
