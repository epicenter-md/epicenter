/**
 * A Svelte 5 adapter over one application handle's store: four states, and the
 * data rides on `ready`.
 *
 * The member is `boot` rather than `state`, because that is what these four
 * are: signed-out, opening, ready, failed is a boot sequence, and `state.status`
 * read as "the state's status". They stay ONE property rather than a `status`
 * beside a `data`, and that is not taste: TypeScript narrows a discriminated
 * union and cannot correlate two properties, so a flat pair would leave `data`
 * optional at every read site and "you cannot read the store before it is open"
 * would stop being a rule the compiler keeps.
 *
 * `epicenter.data` is a promise that settles once. This is what a route renders
 * from while it is settling, and what it renders from afterwards.
 *
 * **Nothing opens until something reads.** The handle's `data` is a lazy getter
 * and so is this: the first read of `boot` starts the open, and it writes no
 * signal synchronously, because the value it would write is the `opening` it
 * already holds. That is what makes it safe inside a `$derived` (unlike
 * `fromData`, which walks every row and is eager for exactly that reason), and
 * safe at module scope, which is where an application should put it:
 *
 * ```ts
 * // apps/<app>/src/lib/epicenter.svelte.ts, one file for every build
 * const handle = createEpicenter({ definition, account: auth, binding });
 * export const epicenter = fromEpicenter(handle);
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
 * **There is no `data` accessor beside `boot`.** The opened store is a field
 * on the `ready` variant, so a read before the store is open does not compile.
 * A top-level accessor could only be a runtime throw, which is a type turned
 * into an invariant, and it could not be read from a `$derived` while opening.
 *
 * @example
 * ```svelte
 * {#if notes.boot.status === 'signed-out'}
 *   <SignInGate />
 * {:else if notes.boot.status === 'opening'}
 *   <Loading />
 * {:else if notes.boot.status === 'ready'}
 *   <Notes data={notes.boot.data} />
 * {:else}
 *   <BootFailure error={notes.boot.error} erase={notes.boot.eraseReplica} />
 * {/if}
 * ```
 */

import { isOk, type Result } from 'wellcrafted/result';
import {
	type AdaptableData,
	fromData,
	type ReactiveData,
} from './from-data.svelte.js';

/**
 * What this needs from an application handle, and nothing more.
 *
 * Structural, the way `AdaptableData` is in `from-data.svelte.ts`, so
 * `@epicenter/svelte` does not grow a dependency on `@epicenter/app`. Reading
 * `data` is what starts the open, so it is declared as a property and read
 * once, late.
 */
type AdaptableEpicenter<TData extends AdaptableData, TError, TEraseError> = {
	readonly account: { readonly state: { readonly status: string } };
	readonly data: Promise<Result<TData, TError>>;
	eraseReplica(): Promise<Result<void, TEraseError>>;
};

/**
 * The four answers a route renders from: the boot, as a state.
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
export type EpicenterBoot<TData extends AdaptableData, TError, TEraseError> =
	| { readonly status: 'signed-out' }
	| { readonly status: 'opening' }
	| { readonly status: 'ready'; readonly data: ReactiveData<TData> }
	| {
			readonly status: 'failed';
			readonly error: TError;
			eraseReplica(): Promise<Result<void, TEraseError>>;
	  };

/**
 * Adapt one application handle into Svelte reactivity: the same epicenter,
 * with its store rendered as a boot.
 *
 * Everything else the handle carries is forwarded untouched, because nothing
 * else about it has states. `sqlite` and `secrets` are verbs that are ready
 * the instant the handle exists, and an application should hold ONE thing
 * called `epicenter` rather than a reactive store beside unrelated storage
 * exports; reactivity is a property of one member, not a reason to split the
 * object.
 *
 * Three members do not come across. `data` is what `boot` replaces. `close` is
 * left behind on purpose, so the only reference to it is the module local that
 * built the handle, which is the one place a hot reload can reach and no route
 * can (ADR-0340). `eraseReplica` rides on the `failed` variant instead, where
 * it is the one state it can succeed in.
 *
 * The forwarding copies property DESCRIPTORS rather than spreading. A spread
 * reads getters, and `data` is a lazy getter whose read starts the open: a
 * signed-out person would claim a Web Lock at module load, which is exactly
 * what the laziness exists to prevent.
 */
export function fromEpicenter<
	TData extends AdaptableData,
	TError,
	TEraseError,
	TEpicenter extends object,
>(
	epicenter: AdaptableEpicenter<TData, TError, TEraseError> & TEpicenter,
): Omit<TEpicenter, 'data' | 'close' | 'eraseReplica'> & {
	readonly boot: EpicenterBoot<TData, TError, TEraseError>;
} {
	// Latched, not tracked. One read, at construction, for the reason above.
	const signedOut = epicenter.account.state.status === 'signed-out';
	let settled = $state.raw<EpicenterBoot<TData, TError, TEraseError>>(
		signedOut ? { status: 'signed-out' } : { status: 'opening' },
	);
	// A plain closure variable rather than a rune: it is written during a read,
	// which is exactly what a rune may not be.
	let started = false;

	const forwarded: PropertyDescriptorMap = {};
	for (const key of Reflect.ownKeys(epicenter)) {
		if (key === 'data' || key === 'close' || key === 'eraseReplica') continue;
		const descriptor = Object.getOwnPropertyDescriptor(epicenter, key);
		if (descriptor !== undefined) forwarded[key as string] = descriptor;
	}

	return Object.freeze(
		Object.defineProperties({} as Record<string, unknown>, {
			...forwarded,
			boot: {
				enumerable: true,
				get() {
					if (!signedOut && !started) {
						started = true;
						// Reading `data` starts the open. Nothing is written to a signal
						// here; `settled` already says `opening`, and the `.then` below runs
						// in a microtask, off the render path.
						epicenter.data.then(
							(opened) => {
								if (!isOk(opened)) {
									settled = {
										status: 'failed',
										error: opened.error,
										eraseReplica: () => epicenter.eraseReplica(),
									};
									return;
								}
								// Awake before it is handed over, so an application receives one
								// object once. `fromData` walks every table, which is why it
								// happens here in a microtask and not in a getter a `$derived`
								// might reach (`state_unsafe_mutation`).
								//
								// It reads the store, so a store closed between the open and
								// this line throws. The only way there is a close before
								// anything read `state`, which is a hot reload replacing this
								// module: the page is going, and `opening` is what it should
								// show on the way out.
								try {
									settled = { status: 'ready', data: fromData(opened.data) };
								} catch {}
							},
							// No rejection arm, because the handle resolves a `Result`: a
							// promise that rejects here is an opener that threw, and one that
							// does leaves this rendering `opening` forever, which is why the
							// opener contains its own throws rather than passing them on.
						);
					}
					return settled;
				},
			},
		}),
	) as Omit<TEpicenter, 'data' | 'close' | 'eraseReplica'> & {
		readonly boot: EpicenterBoot<TData, TError, TEraseError>;
	};
}
