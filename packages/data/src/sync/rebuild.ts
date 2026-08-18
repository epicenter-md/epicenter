/**
 * The client half of ADR-0231's one verb: rebuild the document, publish it.
 *
 * "Rebuild database" is the product's one action over the wire's one verb. This
 * file owns its two halves: the reclaim walk, which re-encodes this replica's
 * live state into entirely new struct identities so every tombstone is
 * reclaimed; and the publish, which posts the reborn bytes with the lease
 * (`fromDocument` compare-and-swap on this replica's stamped identity,
 * `atHead` from its own cursor) and maps the authority's refusals into
 * answers a person can act on.
 *
 * What it deliberately does NOT own: the discard-and-reload that follows a
 * confirmed publish. The initiating device adopts the new document through the
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
import { STORE_REPLACE_ROUTE, WORKSPACE_ID } from '@epicenter/sync';
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

import { type AccountStore, syncEngineOf } from '../store/store.js';

declare const rebuilt: unique symbol;

/**
 * Bytes the reclaim walk minted: fresh identities, zero tombstones.
 *
 * A distinct type on purpose (ADR-0231): `encodeStateSince()` preserves
 * struct identities and reclaims nothing, and handing it to a rebuild "works"
 * while silently defeating the verb. Only `rebuildDocument` produces this.
 */
export type RebuiltState = Uint8Array & { readonly [rebuilt]: true };

export const RebuildError = defineErrors({
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
	RebuildFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The state could not be re-encoded into a fresh document',
		cause,
	}),
	/**
	 * The log moved past the head this rebuild was built from.
	 *
	 * The `atHead` lease doing its job: an entry landed mid-rebuild, and
	 * publishing anyway would silently lose it. Sync, then rebuild again.
	 */
	StoreChanged: ({ head }: { head: number }) => ({
		message: `The log moved to ${head} while rebuilding; sync and try again`,
		head,
	}),
	/**
	 * The document this rebuild was built from is no longer the current one.
	 *
	 * Another replace won (or this is the crash-replay of a rebuild that
	 * already landed and minted the current document). Either way this
	 * replica now belongs to a retired document; its next dial runs the
	 * ordinary adoption, and republishing stale-built bytes over the winner
	 * is exactly what the refusal prevents.
	 */
	Contested: ({ document }: { document: string }) => ({
		message: `Another replace published document '${document}'; adopt it instead`,
		document,
	}),
	/**
	 * This replica has never synced, so there is no authority document its
	 * state provably covers, and nothing for the lease to name.
	 */
	NeverSynced: () => ({
		message:
			'This replica has never synced; rebuild from a device that holds the current document',
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
export type RebuildError = InferErrors<typeof RebuildError>;

/**
 * How a rebuild reaches its authority: the host's authenticated fetch, the
 * deployment's base URL, and the database id it is rebuilding.
 */
export type StoreTransport = {
	fetch(input: string, init?: RequestInit): Promise<Response>;
	baseURL: string;
	databaseId: string;
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
export function rebuildDocument(
	store: AccountStore,
): Result<RebuiltState, RebuildError> {
	if (syncEngineOf(store).hasUnresolvedDependencies()) {
		return RebuildError.UnresolvedDependencies();
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
				return new Uint8Array(Y.encodeStateAsUpdateV2(target)) as RebuiltState;
			} finally {
				source.destroy();
				target.destroy();
			}
		},
		catch: (cause) => RebuildError.RebuildFailed({ cause }),
	});
}

/** What one POST of the verb came back as, refusals included. */
type ReplaceAnswer =
	| { kind: 'published'; document: string }
	| { kind: 'document'; document: string }
	| { kind: 'head'; head: number };

async function postReplace(
	transport: StoreTransport,
	params: { fromDocument: string; atHead: number },
	bytes: RebuiltState,
): Promise<Result<ReplaceAnswer, RebuildError>> {
	const posted = await tryAsync({
		try: () =>
			transport.fetch(
				STORE_REPLACE_ROUTE.url(transport.baseURL, {
					databaseId: transport.databaseId,
					fromDocument: params.fromDocument,
					atHead: params.atHead,
				}),
				{ method: 'POST', body: bytes as Uint8Array<ArrayBuffer> },
			),
		catch: (cause) => RebuildError.ReplaceFailed({ cause }),
	});
	if (posted.error !== null) return Err(posted.error);
	const response = posted.data;

	if (response.ok) {
		const body = await tryAsync({
			try: () => response.json() as Promise<{ document?: unknown }>,
			catch: (cause) => RebuildError.ReplaceFailed({ cause }),
		});
		if (body.error !== null) return Err(body.error);
		const document = body.data.document;
		if (typeof document !== 'string') {
			return RebuildError.ReplaceFailed({
				cause: new Error('the replace answered without a document'),
			});
		}
		return Ok({ kind: 'published', document });
	}

	if (response.status === 409) {
		const refusal = await tryAsync({
			try: () =>
				response.json() as Promise<{
					refused?: unknown;
					document?: unknown;
					head?: unknown;
				}>,
			catch: (cause) => RebuildError.ReplaceFailed({ cause }),
		});
		if (refusal.error !== null) return Err(refusal.error);
		const answer = refusal.data;
		if (answer.refused === 'document' && typeof answer.document === 'string') {
			return Ok({ kind: 'document', document: answer.document });
		}
		if (answer.refused === 'head' && typeof answer.head === 'number') {
			return Ok({ kind: 'head', head: answer.head });
		}
	}
	return RebuildError.ReplaceFailed({ status: response.status });
}

/**
 * Rebuild this database: publish its live state, reborn, as the next document.
 *
 * The lease is this replica's own stamped facts, so there is no bootstrap
 * and no retry loop: `fromDocument` is the identity its state belongs to
 * (the authority refuses if that is no longer the current document), and
 * `atHead` is its cursor (what its state provably covers; the authority
 * refuses if the tail moved). Every refusal is typed for the one question
 * the person asks next: sync and try again (`StoreChanged`), or adopt the
 * document that beat you (`Contested`, which also covers the crash-replay
 * of a rebuild that already landed, so a replay can never publish twice).
 *
 * On success the caller runs the same adoption every superseded replica
 * runs: `discard()` on the opener, then reload. This function never touches
 * the local file, so a crash between publish and discard reduces to the
 * ordinary supersession at the next dial.
 */
export async function rebuildDatabase({
	store,
	transport,
}: {
	store: AccountStore;
	transport: StoreTransport;
}): Promise<Result<{ document: string }, RebuildError>> {
	if (!WORKSPACE_ID.test(transport.databaseId)) {
		return RebuildError.ReplaceFailed({
			cause: new Error(`'${transport.databaseId}' is not a database id`),
		});
	}
	const engine = syncEngineOf(store);
	const identity = engine.documentIdentity();
	if (identity === undefined) return RebuildError.NeverSynced();
	const cursor = engine.cursor();
	const bytes = rebuildDocument(store);
	if (bytes.error !== null) return Err(bytes.error);

	const answer = await postReplace(
		transport,
		{ fromDocument: identity, atHead: cursor },
		bytes.data,
	);
	if (answer.error !== null) return Err(answer.error);
	if (answer.data.kind === 'published') {
		return Ok({ document: answer.data.document });
	}
	if (answer.data.kind === 'head') {
		return RebuildError.StoreChanged({ head: answer.data.head });
	}
	return RebuildError.Contested({ document: answer.data.document });
}
