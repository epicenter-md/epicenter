/**
 * The client half of ADR-0231's one verb: rebirth the state, publish it.
 *
 * "Compact store" is the product's one action over the wire's one verb. This
 * file owns its two halves: the reclaim walk, which re-encodes this replica's
 * live state into entirely new struct identities so every tombstone is
 * reclaimed; and the publish, which posts the reborn bytes with the lease
 * (`fromBoundary` compare-and-swap, `atHead` from this replica's own cursor)
 * and maps the authority's refusals into answers a person can act on.
 *
 * What it deliberately does NOT own: the discard-and-reload that follows a
 * confirmed publish. The initiating device adopts the new edition through the
 * same move every superseded replica makes (`discard()` on its opener, then
 * reload), because one adoption path is the design.
 *
 * ## Why the walk is a hand recursion
 *
 * Upstream `clone()` is `_copy()` plus `applyDelta(toDeltaDeep())`, and in
 * `@y/y@14.0.0-rc.24` that path throws `Unexpected content type` the moment a
 * nested type arrives inside the delta as a delta (`evidence/
 * rebuild-copy.test.ts` pins the defect and this workaround). So sequence
 * content is copied through a type's own delta, which carries formatting
 * marks, and attributes are walked and recursed by hand, so a nested type is
 * copied as a `YType` and set as a `YType`. A sequence-EMBEDDED nested type
 * still reaches `applyDelta` as a delta and throws; that surfaces here as a
 * loud `RebirthFailed` rather than degraded prose, which is the honest
 * failure until upstream fixes `clone()`.
 */
import { LENS_NAMESPACE, STORE_REPLACE_ROUTE } from '@epicenter/sync';
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

import type { Store, StoreError } from '../store/store.js';

declare const reborn: unique symbol;

/**
 * Bytes the reclaim walk minted: fresh identities, zero tombstones.
 *
 * A distinct type on purpose (ADR-0231): `encodeStateSince()` preserves
 * struct identities and reclaims nothing, and handing it to a compact "works"
 * while silently defeating the verb. Only `rebirth` produces this.
 */
export type RebornState = Uint8Array & { readonly [reborn]: true };

export const CompactError = defineErrors({
	/**
	 * This replica's view is incomplete, so it must not become the baseline.
	 *
	 * Yjs buffers an update whose causal dependencies never arrived and
	 * surfaces no error; publishing a state built over that hole would retire
	 * the very entries that could fill it.
	 */
	UnresolvedDependencies: () => ({
		message:
			'This replica is holding updates whose dependencies never arrived, so its state must not become the baseline',
	}),
	/** The walk itself failed; nothing was published and nothing changed. */
	RebirthFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The state could not be re-encoded into a fresh document',
		cause,
	}),
	/**
	 * The log moved past the head this compact was built from.
	 *
	 * The `atHead` lease doing its job: an entry landed mid-compact, and
	 * publishing anyway would silently lose it. Sync, then compact again.
	 */
	StoreChanged: ({ head }: { head: number }) => ({
		message: `The log moved to ${head} while compacting; sync and try again`,
		head,
	}),
	/**
	 * Another replace won the boundary and kept winning through the retries.
	 *
	 * This replica now belongs to a retired edition; its next dial runs the
	 * ordinary adoption. Includes the crash-replay of a compact that already
	 * landed, which is exactly why a replay can never double-publish.
	 */
	Contested: ({ boundary }: { boundary: number }) => ({
		message: `Another replace moved the boundary to ${boundary}; adopt it instead`,
		boundary,
	}),
	/** The POST itself failed: network trouble or a non-lease refusal. */
	ReplaceFailed: ({ status, cause }: { status?: number; cause?: unknown }) => ({
		message:
			status === undefined
				? 'The replace could not be posted'
				: `The replace was not accepted (HTTP ${status})`,
		status,
		cause,
	}),
});
export type CompactError = InferErrors<typeof CompactError>;

/**
 * How a compact reaches its authority: the host's authenticated fetch, the
 * deployment's base URL, and the Lens namespace it is compacting.
 */
export type StoreTransport = {
	fetch(input: string, init?: RequestInit): Promise<Response>;
	baseURL: string;
	namespace: string;
};

/**
 * Copy one type into entirely new struct identities.
 *
 * Sequence content through the type's own delta (which carries formatting
 * marks); attributes walked and recursed, because that is the one shape
 * `typeMapSet` accepts for a nested type (`evidence/rebuild-copy.test.ts`).
 */
function copyInto(source: Y.Type, target: Y.Type): void {
	if (source.length > 0) target.applyDelta(source.delta as never);
	for (const key of source.attrKeys()) {
		const value = source.getAttr(key as never) as unknown;
		if (value instanceof Y.Type) {
			const child = new Y.Type(
				((value as unknown as { name?: string | null }).name ?? null) as never,
			);
			target.setAttr(key as never, child as never);
			copyInto(value, child);
			continue;
		}
		target.setAttr(key as never, value as never);
	}
}

/**
 * Re-encode this replica's live state into a fresh document: same rows, same
 * ids, same prose and marks, new identities, zero tombstones.
 *
 * Reads nothing but the encoded state, so it never touches the live document
 * or its handles. The scratch hydration costs one full decode, which is fine
 * for a person-initiated verb.
 */
export function rebirth(
	store: Pick<Store, 'encodeStateSince' | 'hasUnresolvedDependencies'>,
): Result<RebornState, CompactError> {
	if (store.hasUnresolvedDependencies()) {
		return CompactError.UnresolvedDependencies();
	}
	return trySync({
		try: () => {
			const source = new Y.Doc({ gc: true });
			const target = new Y.Doc({ gc: true });
			try {
				Y.applyUpdateV2(
					source,
					store.encodeStateSince() as Uint8Array<ArrayBuffer>,
				);
				target.transact(() => {
					for (const [rootName, root] of source.share) {
						// Roots are minted by `get`, everything below them by the walk.
						copyInto(
							root,
							target.get(
								rootName,
								((root as unknown as { name?: string | null }).name ??
									null) as never,
							),
						);
					}
				});
				return new Uint8Array(Y.encodeStateAsUpdateV2(target)) as RebornState;
			} finally {
				source.destroy();
				target.destroy();
			}
		},
		catch: (cause) => CompactError.RebirthFailed({ cause }),
	});
}

/** What one POST of the verb came back as, refusals included. */
type ReplaceAnswer =
	| { kind: 'published'; boundary: number }
	| { kind: 'boundary'; boundary: number }
	| { kind: 'head'; head: number };

async function postReplace(
	transport: StoreTransport,
	params: { fromBoundary: number; atHead: number },
	bytes: RebornState,
): Promise<Result<ReplaceAnswer, CompactError>> {
	const posted = await tryAsync({
		try: () =>
			transport.fetch(
				STORE_REPLACE_ROUTE.url(transport.baseURL, {
					namespace: transport.namespace,
					fromBoundary: params.fromBoundary,
					atHead: params.atHead,
				}),
				{ method: 'POST', body: bytes as Uint8Array<ArrayBuffer> },
			),
		catch: (cause) => CompactError.ReplaceFailed({ cause }),
	});
	if (posted.error !== null) return Err(posted.error);
	const response = posted.data;

	if (response.ok) {
		const body = await tryAsync({
			try: () => response.json() as Promise<{ boundary?: unknown }>,
			catch: (cause) => CompactError.ReplaceFailed({ cause }),
		});
		if (body.error !== null) return Err(body.error);
		const boundary = body.data.boundary;
		if (typeof boundary !== 'number') {
			return CompactError.ReplaceFailed({
				cause: new Error('the replace answered without a boundary'),
			});
		}
		return Ok({ kind: 'published', boundary });
	}

	if (response.status === 409) {
		const refusal = await tryAsync({
			try: () =>
				response.json() as Promise<{
					refused?: unknown;
					boundary?: unknown;
					head?: unknown;
				}>,
			catch: (cause) => CompactError.ReplaceFailed({ cause }),
		});
		if (refusal.error !== null) return Err(refusal.error);
		const answer = refusal.data;
		if (answer.refused === 'boundary' && typeof answer.boundary === 'number') {
			return Ok({ kind: 'boundary', boundary: answer.boundary });
		}
		if (answer.refused === 'head' && typeof answer.head === 'number') {
			return Ok({ kind: 'head', head: answer.head });
		}
	}
	return CompactError.ReplaceFailed({ status: response.status });
}

/**
 * Compact this store: publish its live state, reborn, as the next edition.
 *
 * The lease is this replica's own facts: `atHead` is its cursor (what its
 * state provably covers; the authority refuses if the tail moved), and
 * `fromBoundary` bootstraps from zero through the CAS itself: a miss answers
 * the current boundary, and a bounded retry presents it. Every refusal is
 * typed for the one question the person asks next: sync and try again
 * (`StoreChanged`), or adopt the edition that beat you (`Contested`).
 *
 * On success the caller runs the same adoption every superseded replica
 * runs: `discard()` on the opener, then reload. This function never touches
 * the local file, so a crash between publish and discard reduces to the
 * ordinary supersession at the next dial.
 */
export async function compactStore({
	store,
	transport,
	/** CAS retries after the first attempt. Bounded; a compact is not a loop. */
	retries = 2,
}: {
	store: Store;
	transport: StoreTransport;
	retries?: number;
}): Promise<Result<{ boundary: number }, CompactError | StoreError>> {
	if (!LENS_NAMESPACE.test(transport.namespace)) {
		return CompactError.ReplaceFailed({
			cause: new Error(`'${transport.namespace}' is not a Lens namespace`),
		});
	}
	const cursor = store.sync.cursor();
	if (cursor.error !== null) return Err(cursor.error);
	const bytes = rebirth(store);
	if (bytes.error !== null) return Err(bytes.error);

	// The verb is its own bootstrap: the client durably knows no boundary, so
	// the first post claims zero, and a CAS miss ANSWERS the current value,
	// which the retry then presents. One extra round-trip on a rare,
	// person-initiated action, and no read endpoint has to exist for it.
	let fromBoundary = 0;
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		const answer = await postReplace(
			transport,
			{ fromBoundary, atHead: cursor.data },
			bytes.data,
		);
		if (answer.error !== null) return Err(answer.error);
		if (answer.data.kind === 'published') {
			return Ok({ boundary: answer.data.boundary });
		}
		if (answer.data.kind === 'head') {
			return CompactError.StoreChanged({ head: answer.data.head });
		}
		fromBoundary = answer.data.boundary;
	}
	return CompactError.Contested({ boundary: fromBoundary });
}
