import { createSubscriber } from 'svelte/reactivity';
import type { Brand } from 'wellcrafted/brand';
import type { AuthClient } from '../index.js';

// The one composition shape (ADR-0088): the app reads `auth.state` once at
// boot, and a change of auth generation reloads the page so the next boot
// composes from scratch.
export { reloadOnAuthChange } from './reload-on-auth-change.js';

/**
 * An auth client whose `state` and `connection.status` track in Svelte.
 *
 * The brand exists because the same reads are correct two opposite ways and
 * the unbranded type cannot tell you which you are holding. A route reads
 * `auth.state` once at boot and must NOT track (ADR-0088: a page lifetime is
 * one auth generation, and `reloadOnAuthChange` replaces the document rather
 * than swapping state under it). A component that renders the reconnect
 * affordance must track, because `signed-in` degrading to `reauth-required` is
 * the one transition the gate deliberately refuses to reload.
 *
 * So a component that tracks asks for `ReactiveAuthClient`, and a boot reader
 * keeps asking for `AuthClient`: the brand is a subtype, so nothing that reads
 * once has to change, and handing a raw core client to a surface that tracks
 * is a type error rather than a silently frozen popover.
 */
export type ReactiveAuthClient = AuthClient & Brand<'ReactiveAuthClient'>;

/**
 * Bridge an auth client's two external facts into Svelte's graph.
 *
 * The whole of what this module does, and the whole of what it should: a
 * client is composed somewhere that has no framework, and this adapts one.
 * There used to be four exported constructors here, one per composition an app
 * happened to use, each of which was a core constructor with this call wrapped
 * around it. That made the framework wrapper the door to conventions that have
 * nothing to do with a framework, so `@epicenter/auth` could not hand a plain
 * page the hosted browser convention and a Svelte app could not wrap a client
 * this module had not anticipated. One function takes any of them.
 *
 * `createSubscriber` rather than a `$state.raw` shadow, and the difference is
 * not style. It is lazy: the subscription starts only while something is
 * actively reading inside a tracking context, and stops when the last reader
 * is destroyed. That is what lets one wrapped client serve both contracts at
 * once, because a boot-time read outside any effect subscribes to nothing and
 * simply falls through to the live getter. A shadow would subscribe eagerly,
 * once per component instance, for that component's whole life.
 *
 * Both facts are wrapped uniformly even though not every client can change
 * either one. The hosted OAuth and same-origin cookie clients report a
 * constant `connected` with an `onChange` that never fires, and the desktop
 * broker's identity is immutable for its process generation, so their
 * subscribers simply never invalidate. Uniformity is the point: the brand
 * promises that reads track IF the underlying client ever changes, which is a
 * promise every client can keep.
 */
export function reactive(auth: AuthClient): ReactiveAuthClient {
	const subscribeState = createSubscriber((update) =>
		auth.onStateChange(update),
	);
	const connection = auth.connection;
	const subscribeConnection = createSubscriber((update) =>
		connection.onChange(update),
	);
	return {
		...auth,
		get state() {
			subscribeState();
			return auth.state;
		},
		connection: {
			...connection,
			get status() {
				subscribeConnection();
				return connection.status;
			},
		},
	} as ReactiveAuthClient;
}
