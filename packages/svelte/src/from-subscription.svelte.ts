/**
 * One value read through a subscription, kept fresh by Svelte.
 *
 * The whole of what a reactivity adapter does, as one call. A store hands out
 * two things that belong together and are useless apart: a way to read a
 * current value, and a way to hear that it moved. `fromSubscription` is the
 * pair, wired.
 *
 * ```ts
 * const preview = fromSubscription(
 *   (update) => table.watch(body, update),
 *   () => notePreview(body),
 * );
 * preview.current; // re-reads whenever that one content node changes
 * ```
 *
 * **The read is the point, and it is a read-THROUGH.** Nothing is cached here.
 * `current` calls `read()` every time, so what comes back is whatever the
 * document says now, and a commit's phase order cannot serve anyone a value
 * from before it. What the subscription buys is not the value; it is the
 * re-run.
 *
 * **It exists because the announce is the part people forget.** Every hand
 * written version of this is the same four lines, and getting them wrong has
 * one failure mode: the value stays CORRECT and stops updating. No error, no
 * failed assertion, no wrong pixel until someone types and nothing happens.
 * Written once, the announce cannot be omitted, because there is no version of
 * this call that reads without it.
 *
 * **Ref-counted, so a value nobody is looking at costs nothing.** `current`
 * outside an effect reads and subscribes to nothing; read inside one, the
 * subscription attaches, and it detaches when the last reader goes away. A
 * card scrolled out of view stops listening on its own.
 *
 * Use it for one value from one source. A whole handle whose several reads
 * ride ONE subscription is `fromData`'s job, and it wraps the handle rather
 * than calling this per read.
 */

import { createSubscriber } from 'svelte/reactivity';

/** A live value: read `current` and re-run when its source says so. */
export type Tracked<TValue> = { readonly current: TValue };

export function fromSubscription<TValue>(
	subscribe: (update: () => void) => () => void,
	read: () => TValue,
): Tracked<TValue> {
	const announce = createSubscriber(subscribe);
	return {
		get current() {
			announce();
			return read();
		},
	};
}
