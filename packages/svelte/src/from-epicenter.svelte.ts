/**
 * A Svelte 5 adapter over one application handle's store: four states, and the
 * data rides on `ready`.
 *
 * `epicenter.data` is a promise that settles once. This is what a route renders
 * from while it is settling, and what it renders from afterwards.
 *
 * **Nothing opens until something reads.** The handle's `data` is a lazy getter
 * and so is this: the first read of `state` starts the open, and it writes no
 * signal synchronously, because the value it would write is the `opening` it
 * already holds. That is what makes it safe inside a `$derived` (unlike
 * `fromData`, which walks every row and is eager for exactly that reason), and
 * safe at module scope, which is where an application should put it:
 *
 * ```ts
 * // apps/<app>/src/lib/platform/epicenter.browser.svelte.ts
 * export const notes = fromEpicenter(createEpicenter({ definition, account: auth }));
 * ```
 *
 * One call site by construction, so there is no question about who owns the
 * wrapper and nothing to memoize. A route that never renders the store never
 * opens one: importing this module claims no Web Lock, touches no IndexedDB,
 * and makes no round trip.
 *
 * **Signed-out is answered before anything opens**, from one read of
 * `account.state`, latched at construction. The read is deliberately not
 * reactive, because a page lifetime is one auth generation (ADR-0088):
 * `reloadOnAuthChange` replaces the document on every transition that
 * invalidates this page, so a second, competing answer to auth underneath it
 * would be dead for the transitions that reload and wrong for the one that
 * deliberately does not. **That gate is this wrapper's precondition.** An
 * application whose layout does not mount it signs a person in and leaves them
 * looking at the sign-in screen until they reload by hand, and nothing here can
 * tell.
 *
 * It is its own state rather than a failure, because folding it into the
 * failure channel would make a route sniff an error to choose between "sign in"
 * and "something broke", and a signed-out open refuses with `Unaddressable`.
 *
 * **The settled value is held in `$state.raw`, reassigned from the promise's
 * `.then`, not in a `createSubscriber`.** A subscriber is for a source with a
 * live read and a subscribe pair, and its start function re-runs if every
 * reader goes away and returns; a promise settles once, cannot be
 * unsubscribed, and must not be forgotten because the last reader navigated
 * away. The auth adapter next door does use `createSubscriber`, because an auth
 * client is that kind of source, so the two differ on purpose.
 *
 * **There is no `data` accessor beside `state`.** The opened store is a field
 * on the `ready` variant, so a read before the store is open does not compile.
 * A top-level accessor could only be a runtime throw, which is a type turned
 * into an invariant, and it could not be read from a `$derived` while opening.
 *
 * @example
 * ```svelte
 * {#if notes.state.status === 'signed-out'}
 *   <SignInGate />
 * {:else if notes.state.status === 'opening'}
 *   <Loading />
 * {:else if notes.state.status === 'ready'}
 *   <Notes data={notes.state.data} />
 * {:else}
 *   <BootFailure error={notes.state.error} erase={notes.state.eraseReplica} />
 * {/if}
 * ```
 */

import { isOk, type Result } from 'wellcrafted/result';

/**
 * What this needs from an application handle, and nothing more.
 *
 * Structural, the way `AdaptableData` is in `from-data.svelte.ts`, so
 * `@epicenter/svelte` does not grow a dependency on `@epicenter/app`. Reading
 * `data` is what starts the open, so it is declared as a property and read
 * once, late.
 */
type AdaptableEpicenter<TData, TError, TEraseError> = {
	readonly account: { readonly state: { readonly status: string } };
	readonly data: Promise<Result<TData, TError>>;
	eraseReplica(): Promise<Result<void, TEraseError>>;
};

/**
 * The four answers a route renders from.
 *
 * `ready` carries the store and `failed` carries the error, because each is
 * only meaningful in its own state, and a variant is how that stops being a
 * comment.
 *
 * **`eraseReplica` is on `failed` and nowhere else**, and that is an invariant
 * rather than a convenience: erasing takes the same claim an open takes, so
 * erasing while the store is open is refused by the store itself. A failed open
 * released its claim before it returned, which makes `failed` the one state
 * where the verb can succeed.
 */
export type EpicenterState<TData, TError, TEraseError> =
	| { readonly status: 'signed-out' }
	| { readonly status: 'opening' }
	| { readonly status: 'ready'; readonly data: TData }
	| {
			readonly status: 'failed';
			readonly error: TError;
			eraseReplica(): Promise<Result<void, TEraseError>>;
	  };

export type EpicenterStore<TData, TError, TEraseError> = {
	readonly state: EpicenterState<TData, TError, TEraseError>;
};

/** Adapt one application handle's store into Svelte reactivity. */
export function fromEpicenter<TData, TError, TEraseError>(
	epicenter: AdaptableEpicenter<TData, TError, TEraseError>,
): EpicenterStore<TData, TError, TEraseError> {
	// Latched, not tracked. One read, at construction, for the reason above.
	const signedOut = epicenter.account.state.status === 'signed-out';
	let settled = $state.raw<EpicenterState<TData, TError, TEraseError>>(
		signedOut ? { status: 'signed-out' } : { status: 'opening' },
	);
	// A plain closure variable rather than a rune: it is written during a read,
	// which is exactly what a rune may not be.
	let started = false;

	return Object.freeze({
		get state() {
			if (!signedOut && !started) {
				started = true;
				// Reading `data` starts the open. Nothing is written to a signal
				// here; `settled` already says `opening`, and the `.then` below runs
				// in a microtask, off the render path.
				epicenter.data.then(
					(opened) => {
						settled = isOk(opened)
							? { status: 'ready', data: opened.data }
							: {
									status: 'failed',
									error: opened.error,
									eraseReplica: () => epicenter.eraseReplica(),
								};
					},
					// No rejection arm, because the handle resolves a `Result`: a
					// promise that rejects here is an opener that threw, and one that
					// does leaves this rendering `opening` forever, which is why the
					// opener contains its own throws rather than passing them on.
				);
			}
			return settled;
		},
	});
}
