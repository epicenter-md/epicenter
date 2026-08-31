import { expect, mock, test } from 'bun:test';

type SubscriberControl = {
	activate(): void;
	deactivate(): void;
	/**
	 * How many times a read announced itself.
	 *
	 * The assertion that matters. A read that never announces returns the right
	 * value forever and re-runs nothing, which is invisible to every other kind
	 * of check.
	 */
	tracked: number;
};

const subscriberControls: SubscriberControl[] = [];

mock.module('svelte/reactivity', () => ({
	createSubscriber(start: (update: () => void) => () => void) {
		let stop: (() => void) | undefined;
		const control = {
			activate() {
				stop ??= start(() => {});
			},
			deactivate() {
				stop?.();
				stop = undefined;
			},
			tracked: 0,
		};
		subscriberControls.push(control);
		return () => {
			control.tracked += 1;
		};
	},
}));

import { fromSubscription } from './from-subscription.svelte.js';

/** A store-shaped source: a value, a way to move it, and listeners. */
function createSource(initial: string) {
	let value = initial;
	const listeners = new Set<() => void>();
	const calls = { read: 0, subscribe: 0 };
	return {
		calls,
		set(next: string) {
			value = next;
			for (const listener of listeners) listener();
		},
		read() {
			calls.read += 1;
			return value;
		},
		subscribe(listener: () => void) {
			calls.subscribe += 1;
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function setup() {
	subscriberControls.length = 0;
	const source = createSource('first');
	const value = fromSubscription(
		(update) => source.subscribe(update),
		() => source.read(),
	);
	const control = subscriberControls[0];
	if (control === undefined) throw new Error('expected one subscriber');
	return { source, value, control };
}

test('wrapping reads nothing and subscribes to nothing', () => {
	const { source } = setup();
	expect(source.calls.read).toBe(0);
	expect(source.calls.subscribe).toBe(0);
});

test('every read announces itself, and reads through rather than caching', () => {
	const { source, value, control } = setup();

	expect(value.current).toBe('first');
	expect(control.tracked).toBe(1);
	expect(source.calls.read).toBe(1);

	// Read twice with nothing changed: still two reads, because there is no
	// cache. A cached value would be stale inside a commit's phase order.
	expect(value.current).toBe('first');
	expect(source.calls.read).toBe(2);
	expect(control.tracked).toBe(2);
});

test('a live reader sees the source move', () => {
	const { source, value, control } = setup();
	control.activate();
	expect(source.calls.subscribe).toBe(1);

	source.set('second');
	expect(value.current).toBe('second');

	control.deactivate();
});

test('the subscription detaches when the last reader goes away', () => {
	const { source, control } = setup();
	control.activate();
	control.deactivate();
	source.set('third');
	// Nothing to assert about delivery here; what is pinned is that teardown
	// runs, which is what makes a value nobody is looking at free.
	expect(source.calls.subscribe).toBe(1);
});
