/**
 * A Svelte 5 adapter over one application handle's data session: the same
 * epicenter, with `state` made reactive and its store adapted on the way to
 * `ready`.
 *
 * The core session already owns the state machine. It publishes four states
 * and hands out an unsubscribe, which is a source with a live read and a
 * subscribe pair; all this does is mirror it into a rune and run `fromData`
 * once, at the moment a store becomes readable. There is no second lifecycle
 * here and no second answer to what the session is doing.
 *
 * **Nothing opens until an application says so.** `createEpicenter` is inert
 * and so is this: constructing it subscribes and reads one state. What
 * acquires is `open`, which comes across untouched, and an application calls it
 * from its root once authentication is ready:
 *
 * ```ts
 * // apps/<app>/src/lib/epicenter.svelte.ts, one file for every build
 * const handle = createEpicenter({ appId, definition, account: auth, binding });
 * export const epicenter = fromEpicenter(handle);
 * ```
 *
 * One call site by construction, so there is no question about who owns the
 * wrapper and nothing to memoize.
 *
 * **Signed-out is not a state here any more.** It never was a fact about the
 * session: it was a latched read of `account.state` that the wrapper performed
 * because reading `data` would otherwise open into `Unaddressable`. With
 * opening explicit, an application that has not authenticated simply has not
 * called `open`, and the session is `closed`, which is exactly true. The gate
 * moves to the boot node, which is where the auth client already is, and this
 * package stops carrying a second opinion about authentication. **That gate is
 * still this wrapper's precondition**: a page lifetime is one auth generation
 * (ADR-0088), and an application whose layout does not mount `reloadOnAuthChange`
 * signs a person in and leaves them looking at the sign-in screen.
 *
 * **The settled value is held in `$state.raw`, written from the session's own
 * subscription.** The auth adapter next door uses `createSubscriber`, and this
 * deliberately does not: a subscriber's start function re-runs if every reader
 * goes away and returns, and a session that stopped being observed for one
 * frame must not be re-read as if it were new. The subscription is taken at
 * construction, for the life of the module that built it.
 *
 * **There is no `data` accessor beside `state`.** The opened store is a field
 * on the `ready` variant, so a read before the store is open does not compile.
 * A top-level accessor could only be a runtime throw, which is a type turned
 * into an invariant.
 *
 * @example
 * ```svelte
 * {#if epicenter.state.status === 'opening' || epicenter.state.status === 'closed'}
 *   <Loading />
 * {:else if epicenter.state.status === 'ready'}
 *   <Notes data={epicenter.state.data} />
 * {:else if epicenter.state.status === 'failed'}
 *   <p>{sentenceFor(epicenter.state.error)}</p>
 *   <button onclick={() => void epicenter.open()}>Try again</button>
 * {/if}
 * ```
 */

import {
	type AdaptableData,
	fromData,
	type ReactiveData,
} from './from-data.svelte.js';

/**
 * What one data session reports, as this package needs to read it.
 *
 * Structural, the way `AdaptableData` is in `from-data.svelte.ts`, so
 * `@epicenter/svelte` does not grow a dependency on `@epicenter/app`.
 */
export type AdaptableEpicenterState<TData extends AdaptableData, TError> =
	| { readonly status: 'closed' }
	| { readonly status: 'opening' }
	| { readonly status: 'ready'; readonly data: TData }
	| { readonly status: 'failed'; readonly error: TError };

/**
 * What this needs from an application handle, and nothing more.
 *
 * `state` is a plain snapshot and `onStateChange` is how the next one arrives.
 * Neither acquires anything, which is why this can be read and subscribed at
 * module scope.
 */
type AdaptableEpicenter<TData extends AdaptableData, TError> = {
	readonly state: AdaptableEpicenterState<TData, TError>;
	onStateChange(
		listener: (state: AdaptableEpicenterState<TData, TError>) => void,
	): () => void;
};

/**
 * The four answers a route renders from: the session's own state, with the
 * store adapted. `ReactiveEpicenterState` rather than `EpicenterState`, which is
 * the core's: the two differ exactly where `ReactiveData` differs from `Data`.
 *
 * The shape is the core's, one member at a time, with one difference and it is
 * this package's job: `ready` carries a `ReactiveData` rather than the raw
 * store.
 *
 * **One rule places every verb: a verb rides on the state when that state is
 * the only one it can succeed in, and stays at the top level otherwise.**
 * `open` is at the top level because it succeeds from three of the four, which
 * is what makes it both the first call and the retry, and putting it on a
 * variant would mean writing it on three of them. `eraseReplica` was on
 * `failed` while erasing needed a session that held no claim; the handle closes
 * before it erases now, so the verb succeeds from every state and no state is
 * the one place to hang it.
 */
export type ReactiveEpicenterState<TData extends AdaptableData, TError> =
	| { readonly status: 'closed' }
	| { readonly status: 'opening' }
	| { readonly status: 'ready'; readonly data: ReactiveData<TData> }
	| { readonly status: 'failed'; readonly error: TError };

/**
 * Adapt one application handle into Svelte reactivity: the same epicenter,
 * with its data session rendered as reactive state.
 *
 * Everything else the handle carries is forwarded untouched, because nothing
 * else about it has states. `open`, `sqlite`, and `secrets` are verbs that are
 * ready the instant the handle exists, and an application should hold ONE thing
 * called `epicenter` rather than a reactive session beside unrelated storage
 * exports; reactivity is a property of one member, not a reason to split the
 * object.
 *
 * Three members do not come across. `state` is replaced. `onStateChange` is
 * consumed here, and forwarding it would offer a route a second way to watch
 * the same thing that is not a rune. `close` is left behind because ending the
 * session is not a route's decision, which is a narrower claim than "no route
 * can reach it": `eraseReplica` IS forwarded and it closes, so a route can end
 * the session, but only as a step in a deletion the person asked for. The two
 * callers are the module local that built the handle, which is what a hot
 * reload reaches (ADR-0340), and that erase.
 *
 * The forwarding copies property DESCRIPTORS rather than spreading, so a member
 * an application adds as a getter stays one.
 */
export function fromEpicenter<
	TData extends AdaptableData,
	TError,
	TEpicenter extends object,
>(
	epicenter: AdaptableEpicenter<TData, TError> & TEpicenter,
): Omit<TEpicenter, 'state' | 'onStateChange' | 'close'> & {
	readonly state: ReactiveEpicenterState<TData, TError>;
} {
	/**
	 * Adapt one core state into this package's.
	 *
	 * `fromData` walks every table and builds a projection per table, so it runs
	 * exactly once per store: here, when a store first appears, and never in a
	 * getter a `$derived` might reach (`state_unsafe_mutation`).
	 */
	const adapt = (
		next: AdaptableEpicenterState<TData, TError>,
	): ReactiveEpicenterState<TData, TError> => {
		return next.status === 'ready'
			? { status: 'ready', data: fromData(next.data) }
			: next;
	};

	let state = $state.raw(adapt(epicenter.state));
	// Taken at construction and never released: the module that built the handle
	// is the thing this lives as long as. There is no reader-counted start and
	// stop, because a session that nothing rendered for one frame is not new.
	epicenter.onStateChange((next) => {
		state = adapt(next);
	});

	const forwarded: PropertyDescriptorMap = {};
	for (const key of Reflect.ownKeys(epicenter)) {
		if (key === 'state' || key === 'onStateChange' || key === 'close') {
			continue;
		}
		const descriptor = Object.getOwnPropertyDescriptor(epicenter, key);
		if (descriptor !== undefined) forwarded[key as string] = descriptor;
	}

	return Object.freeze(
		Object.defineProperties({} as Record<string, unknown>, {
			...forwarded,
			state: {
				enumerable: true,
				get() {
					return state;
				},
			},
		}),
	) as Omit<TEpicenter, 'state' | 'onStateChange' | 'close'> & {
		readonly state: ReactiveEpicenterState<TData, TError>;
	};
}
