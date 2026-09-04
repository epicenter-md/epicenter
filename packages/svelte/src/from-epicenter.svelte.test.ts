import { afterAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { compileModule } from 'svelte/compiler';
import { Ok } from 'wellcrafted/result';
import type { fromEpicenter as FromEpicenter } from './from-epicenter.svelte.js';

/**
 * The wrapper, compiled and run.
 *
 * Runes are a compiler feature, so a `.svelte.ts` module cannot be imported by
 * a plain test: `$state.raw` is not a function anything exports. This does what
 * the build does, in the same order: strip the types, then `compileModule`. What
 * is exercised below is the real module rather than a hand-copy of its logic.
 *
 * The compiled file lands beside this one because `svelte/internal/client` has
 * to resolve from inside the package.
 */
const compiled = new URL('./from-epicenter.compiled.mjs', import.meta.url);
writeFileSync(
	compiled,
	compileModule(
		new Bun.Transpiler({ loader: 'ts' }).transformSync(
			await Bun.file(
				new URL('./from-epicenter.svelte.ts', import.meta.url),
			).text(),
		),
		{ generate: 'client', filename: 'from-epicenter.svelte.js' },
	).js.code,
);
afterAll(() => rmSync(compiled, { force: true }));

const { fromEpicenter } = (await import(compiled.href)) as {
	fromEpicenter: typeof FromEpicenter;
};

/** The slice `fromData` needs, so the fake is a store rather than a stand-in. */
type Store = {
	tables: Record<string, never>;
	kv: {
		get(key: never): unknown;
		nonconforming: unknown[];
		subscribe(l: () => void): () => void;
	};
	transact<TResult>(run: () => TResult): TResult;
	persistence: { get(): unknown; subscribe(l: () => void): () => void };
	address: string;
};

const nothing = () => () => undefined;
function store(address: string): Store {
	return {
		tables: {},
		kv: { get: () => undefined, nonconforming: [], subscribe: nothing },
		transact: (run) => run(),
		persistence: { get: () => 'saved', subscribe: nothing },
		address,
	};
}
/**
 * A handle whose state this test drives, the way the core session does.
 *
 * It records subscriptions and erases, and it never opens anything: what
 * acquires is `open`, which this wrapper forwards untouched, so nothing here
 * needs to fake acquisition to test the adapter.
 */
function handle(
	initial: { status: 'closed' } | { status: 'opening' } = { status: 'closed' },
) {
	type State =
		| { status: 'closed' }
		| { status: 'opening' }
		| { status: 'ready'; data: Store }
		| { status: 'failed'; error: string };
	let state: State = initial;
	const listeners = new Set<(state: State) => void>();
	let erases = 0;
	let opens = 0;
	return {
		erases: () => erases,
		opens: () => opens,
		listeners: () => listeners.size,
		publish(next: State) {
			state = next;
			for (const listener of listeners) listener(next);
		},
		epicenter: {
			get state() {
				return state;
			},
			open: async () => {
				opens += 1;
				return Ok(undefined);
			},
			onStateChange: (listener: (state: State) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			eraseReplica: async () => {
				erases += 1;
				return Ok(undefined);
			},
		},
	};
}

test('constructing mirrors the session and opens nothing', () => {
	const held = handle();
	const epicenter = fromEpicenter(held.epicenter);

	// The whole of what construction does: read one state and subscribe. A
	// handle that has not been opened reports `closed`, and reading it a second
	// time is still a plain property read.
	expect(epicenter.state).toEqual({ status: 'closed' });
	expect(epicenter.state).toEqual({ status: 'closed' });
	expect(held.opens()).toBe(0);
	expect(held.listeners()).toBe(1);
});

test("opening is the application's call, and it comes across untouched", async () => {
	const held = handle();
	const epicenter = fromEpicenter(held.epicenter);

	await epicenter.open();
	expect(held.opens()).toBe(1);

	// The session reports `opening` itself; the wrapper does not guess it.
	held.publish({ status: 'opening' });
	expect(epicenter.state).toEqual({ status: 'opening' });
});

test('the rest of the handle comes across, and reading it opens nothing', () => {
	const held = handle();
	const full = Object.defineProperties(
		{
			appId: 'so.epicenter.notes',
			sqlite: { open: async () => Ok('opened') },
			secrets: { get: async () => Ok(null) },
			close: async () => undefined,
		},
		Object.getOwnPropertyDescriptors(held.epicenter),
	);
	const epicenter = fromEpicenter(full as never) as unknown as {
		appId: string;
		sqlite: { open(): Promise<unknown> };
		secrets: { get(): Promise<unknown> };
		close?: unknown;
		onStateChange?: unknown;
		eraseReplica?: unknown;
	};

	// One `epicenter`, not a session beside unrelated storage exports.
	expect(epicenter.appId).toBe('so.epicenter.notes');
	expect(typeof epicenter.sqlite.open).toBe('function');
	expect(typeof epicenter.secrets.get).toBe('function');

	// Ending the store is the module local's, erasing rides on `failed`, and
	// the raw subscription is consumed rather than offered as a second way to
	// watch what the rune already reports.
	expect('close' in epicenter).toBe(false);
	expect('onStateChange' in epicenter).toBe(false);
	expect('eraseReplica' in epicenter).toBe(false);
});

test('the store rides on ready, adapted once, with everything else intact', () => {
	const held = handle({ status: 'opening' });
	const epicenter = fromEpicenter(held.epicenter);
	expect(epicenter.state.status).toBe('opening');

	held.publish({ status: 'ready', data: store('epicenter/v4/app/data/1') });
	if (epicenter.state.status !== 'ready') throw new Error('expected ready');
	// Adapted, not narrowed: every member the store had is still there, which is
	// what lets one object be handed over once instead of a store and a view of
	// it. The address is the member the folder verbs read.
	expect(epicenter.state.data.address).toBe('epicenter/v4/app/data/1');
	expect(epicenter.state.data.transact(() => 'ran')).toBe('ran');

	// One projection per store, built when the store appeared rather than on
	// every read: `fromData` walks every table and subscribes to each one.
	const first = epicenter.state.data;
	expect(epicenter.state.data).toBe(first);
});

test('the data on ready cannot end the session', () => {
	const held = handle({ status: 'opening' });
	const epicenter = fromEpicenter(held.epicenter);
	held.publish({ status: 'ready', data: store('epicenter/v4/app/data/1') });
	if (epicenter.state.status !== 'ready') throw new Error('expected ready');

	// A component is handed `state.data` and nothing else, so the lock, the
	// socket, and the listener the session acquired together stay in one hand
	// (ADR-0340).
	for (const verb of ['open', 'close', 'erase', 'eraseReplica']) {
		expect(verb in epicenter.state.data).toBe(false);
	}
});

test('a failure carries the error and the erase, and nothing else does', async () => {
	const held = handle({ status: 'opening' });
	const epicenter = fromEpicenter(held.epicenter);

	held.publish({ status: 'failed', error: 'BoundElsewhere' });
	if (epicenter.state.status !== 'failed')
		throw new Error('expected a failure');
	expect(epicenter.state.error).toBe('BoundElsewhere');

	// Erasing takes the same claim an open takes, so it can only succeed in the
	// state that hands it over: a failed open released its claim before it
	// returned.
	await epicenter.state.eraseReplica();
	expect(held.erases()).toBe(1);

	// And the repair is a second `open`, which is the state machine's own way
	// back rather than a document reload.
	held.publish({ status: 'closed' });
	expect((epicenter.state as { status: string }).status).toBe('closed');
});
