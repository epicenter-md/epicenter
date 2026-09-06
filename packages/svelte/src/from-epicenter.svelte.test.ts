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
			close: async () => undefined,
		},
		Object.getOwnPropertyDescriptors(held.epicenter),
	);
	const epicenter = fromEpicenter(full as never) as unknown as {
		appId: string;
		close?: unknown;
		onStateChange?: unknown;
		eraseReplica?: unknown;
	};

	// Plain members come across untouched, and reading one acquires nothing.
	expect(epicenter.appId).toBe('so.epicenter.notes');

	// Ending the store is the module local's, and the raw subscription is
	// consumed rather than offered as a second way to watch what the rune
	// already reports. Erasing IS forwarded, like every other verb: it closes
	// the session itself, so an account surface can invoke it while the store
	// is open.
	expect('close' in epicenter).toBe(false);
	expect('onStateChange' in epicenter).toBe(false);
	expect(typeof epicenter.eraseReplica).toBe('function');
});

test('`close` is dropped from the type, not only from the object', () => {
	const held = handle();
	const epicenter = fromEpicenter({
		...held.epicenter,
		close: async () => undefined,
	});

	// The runtime half is asserted above, and it is the weaker half: a route
	// reaching for `close` would still compile and fail at the call. The type is
	// what makes the module local that built the handle the only caller there is
	// (ADR-0344), so a change that started forwarding it fails here rather than
	// in an application that reopens a session its replacement module holds.
	type CloseIsDropped = 'close' extends keyof typeof epicenter ? never : true;
	const dropped: CloseIsDropped = true;

	expect(dropped).toBe(true);
	expect('close' in epicenter).toBe(false);
});

test('the store rides on ready, adapted once, with everything else intact', () => {
	const held = handle({ status: 'opening' });
	const epicenter = fromEpicenter(held.epicenter);
	expect(epicenter.state.status).toBe('opening');

	held.publish({
		status: 'ready',
		data: store('epicenter/v5/app/alice/data/1'),
	});
	if (epicenter.state.status !== 'ready') throw new Error('expected ready');
	// Adapted, not narrowed: every member the store had is still there, which is
	// what lets one object be handed over once instead of a store and a view of
	// it. The address is the member the folder verbs read.
	expect(epicenter.state.data.address).toBe('epicenter/v5/app/alice/data/1');
	expect(epicenter.state.data.transact(() => 'ran')).toBe('ran');

	// One projection per store, built when the store appeared rather than on
	// every read: `fromData` walks every table and subscribes to each one.
	const first = epicenter.state.data;
	expect(epicenter.state.data).toBe(first);
});

test('the data on ready cannot end the session', () => {
	const held = handle({ status: 'opening' });
	const epicenter = fromEpicenter(held.epicenter);
	held.publish({
		status: 'ready',
		data: store('epicenter/v5/app/alice/data/1'),
	});
	if (epicenter.state.status !== 'ready') throw new Error('expected ready');

	// A component is handed `state.data` and nothing else, so the lock, the
	// socket, and the listener the session acquired together stay in one hand
	// (ADR-0340).
	for (const verb of ['open', 'close', 'erase', 'eraseReplica']) {
		expect(verb in epicenter.state.data).toBe(false);
	}
});

test('a failure carries the error and nothing else', async () => {
	const held = handle({ status: 'opening' });
	const epicenter = fromEpicenter(held.epicenter);

	held.publish({ status: 'failed', error: 'GenerationUnreachable' });
	if (epicenter.state.status !== 'failed')
		throw new Error('expected a failure');
	expect(epicenter.state.error).toBe('GenerationUnreachable');

	// The erase does not ride here any more. It closes the session itself, so
	// no state is the one place it can succeed, and hanging it on a variant
	// would be the placement rule saying something untrue.
	expect('eraseReplica' in epicenter.state).toBe(false);

	// And the repair is a second `open`, which is the state machine's own way
	// back rather than a document reload.
	held.publish({ status: 'closed' });
	expect((epicenter.state as { status: string }).status).toBe('closed');
});

test('erasing is forwarded at the top level, reachable from every state', async () => {
	const held = handle({ status: 'opening' });
	const epicenter = fromEpicenter(held.epicenter) as unknown as {
		eraseReplica(): Promise<unknown>;
	};
	held.publish({
		status: 'ready',
		data: store('epicenter/v5/app/alice/data/1'),
	});

	// The live path is an account surface, which is mounted while the store is
	// open. The handle closes before it erases, so `ready` is exactly where this
	// has to work.
	await epicenter.eraseReplica();
	expect(held.erases()).toBe(1);
});
