/**
 * A Svelte 5 adapter over one application handle's store: four states, and the
 * data rides on `ready`.
 *
 * `epicenter.data` is a promise that settles once. This is what a route renders
 * from while it is settling, and what it renders from afterwards.
 *
 * **Signed-out is answered before anything opens.** One read of
 * `account.state`, at construction, and if it says signed-out this never
 * touches `data`. That is the whole point of the handle's lazy getter: a person
 * who cannot open anything pays no Web Lock, no IndexedDB, and no round trip.
 * The read is deliberately not reactive, because a page lifetime is one auth
 * generation (ADR-0088): `reloadOnAuthChange` replaces the document on every
 * transition that invalidates this page, so a second, competing answer to auth
 * underneath it would be dead for the transitions that reload and wrong for the
 * one that deliberately does not. **That gate is this wrapper's precondition.**
 * An application whose layout does not mount it signs a person in and leaves
 * them looking at the sign-in screen until they reload by hand, and nothing
 * here can tell.
 *
 * **Signed-out is its own state rather than a failure.** Folding it into the
 * failure channel would make a route sniff an error to choose between "sign in"
 * and "something broke", and a signed-out open refuses with `Unaddressable`,
 * which a boot gate reads as a bad link.
 *
 * **The settled value is held in `$state.raw`, written from the promise's
 * `.then`, not in a `createSubscriber`.** A subscriber is for a source with a
 * live read and a subscribe pair, and its start function re-runs if every
 * reader goes away and returns; a promise settles once, cannot be unsubscribed,
 * and must not be forgotten because the last reader navigated away. The auth
 * adapter next door does use `createSubscriber`, because an auth client is that
 * kind of source, so the two differ on purpose.
 *
 * **There is no `data` accessor beside `state`.** The opened store is a field
 * on the `ready` variant, so a read before the store is open does not compile.
 * A top-level accessor could only be a runtime throw, which is a type turned
 * into an invariant, and it could not be read from a `$derived` while opening
 * without becoming a render error.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   const store = fromEpicenter(epicenter);
 * </script>
 * {#if store.state.status === 'signed-out'}
 *   <SignInGate />
 * {:else if store.state.status === 'opening'}
 *   <Loading />
 * {:else if store.state.status === 'ready'}
 *   <Notes data={store.state.data} />
 * {:else}
 *   <BootFailure error={store.state.error} />
 * {/if}
 * ```
 */

import { isOk, type Result } from 'wellcrafted/result';

/**
 * What this needs from an application handle, and nothing more.
 *
 * Structural, the way `AdaptableData` is in `from-data.svelte.ts`, so
 * `@epicenter/svelte` does not grow a dependency on `@epicenter/app`. Two
 * members: the account's state, read once, and the promise the handle opens
 * lazily. Reading `data` is what starts the open, so this type is also the
 * reason the property is declared and not called.
 */
type AdaptableEpicenter<TData, TError> = {
	readonly account: { readonly state: { readonly status: string } };
	readonly data: Promise<Result<TData, TError>>;
};

/**
 * The four answers a route renders from.
 *
 * `ready` carries the store and `failed` carries the error, because each is
 * only meaningful in its own state, and a variant is how that stops being a
 * comment.
 */
export type EpicenterState<TData, TError> =
	| { readonly status: 'signed-out' }
	| { readonly status: 'opening' }
	| { readonly status: 'ready'; readonly data: TData }
	| { readonly status: 'failed'; readonly error: TError };

export type EpicenterStore<TData, TError> = {
	readonly state: EpicenterState<TData, TError>;
};

/** Adapt one application handle's store into Svelte reactivity. */
export function fromEpicenter<TData, TError>(
	epicenter: AdaptableEpicenter<TData, TError>,
): EpicenterStore<TData, TError> {
	if (epicenter.account.state.status === 'signed-out') {
		const signedOut = { status: 'signed-out' } as const;
		return Object.freeze({
			get state() {
				return signedOut;
			},
		});
	}

	let settled = $state.raw<EpicenterState<TData, TError>>({
		status: 'opening',
	});
	// Reading `data` here is what starts the open, and it is read exactly once:
	// the handle memoizes, but so does this, and the promise below is the only
	// thing that ever writes `settled`.
	epicenter.data.then(
		(opened) => {
			settled = isOk(opened)
				? { status: 'ready', data: opened.data }
				: { status: 'failed', error: opened.error };
		},
		// No rejection arm, because the handle resolves a `Result`: a promise
		// that rejects here is an opener that threw, and one that does leaves
		// this rendering `opening` forever, which is why the opener contains its
		// own throws rather than passing them on.
	);

	return Object.freeze({
		get state() {
			return settled;
		},
	});
}
