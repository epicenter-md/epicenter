import { afterAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { compileModule } from 'svelte/compiler';
import { Err, Ok } from 'wellcrafted/result';
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
type Opened = ReturnType<typeof Ok<Store>> | ReturnType<typeof Err<string>>;

/**
 * A handle whose `data` records whether anything read it.
 *
 * The laziness is the contract: reading `data` is what starts an open, claims a
 * Web Lock, and touches IndexedDB, so a page that never renders the store must
 * never read it.
 */
function handle(status: 'signed-in' | 'signed-out', settle: Promise<Opened>) {
	let reads = 0;
	let erases = 0;
	return {
		reads: () => reads,
		erases: () => erases,
		epicenter: {
			account: { state: { status } },
			get data() {
				reads += 1;
				return settle;
			},
			eraseReplica: async () => {
				erases += 1;
				return Ok(undefined);
			},
		},
	};
}

const never = new Promise<Opened>(() => {});

test('constructing opens nothing, and the first read of boot is what starts it', () => {
	const held = handle('signed-in', never);
	const store = fromEpicenter(held.epicenter);
	expect(held.reads()).toBe(0);

	expect(store.boot.status).toBe('opening');
	expect(held.reads()).toBe(1);

	// A second read joins the first. The handle memoizes too, but this must not
	// depend on that: an application reads `state` on every render.
	expect(store.boot.status).toBe('opening');
	expect(held.reads()).toBe(1);
});

test('a signed-out person never touches the store at all', () => {
	const held = handle('signed-out', never);
	const store = fromEpicenter(held.epicenter);

	expect(store.boot.status).toBe('signed-out');
	expect(store.boot.status).toBe('signed-out');
	// No Web Lock, no IndexedDB, no round trip. Signed-out is answered from one
	// read of the account, before anything opens.
	expect(held.reads()).toBe(0);
});

test('the store rides on ready, awake, with everything else intact', async () => {
	const opened = store('epicenter/v4/app/data/1');
	const held = handle('signed-in', Promise.resolve(Ok(opened)));
	const wrapper = fromEpicenter(held.epicenter);
	expect(wrapper.boot.status).toBe('opening');

	await Bun.sleep(1);
	if (wrapper.boot.status !== 'ready') throw new Error('expected ready');
	// Adapted, not narrowed: every member the store had is still there, which is
	// what lets one object be handed over once instead of a store and a view of
	// it. The address is the member the folder verbs read.
	expect(wrapper.boot.data.address).toBe('epicenter/v4/app/data/1');
	expect(wrapper.boot.data.transact(() => 'ran')).toBe('ran');
});

test('a failure carries the error and the erase, and nothing else does', async () => {
	const held = handle('signed-in', Promise.resolve(Err('BoundElsewhere')));
	const store = fromEpicenter(held.epicenter);
	void store.boot;

	await Bun.sleep(1);
	if (store.boot.status !== 'failed') throw new Error('expected a failure');
	expect(store.boot.error).toBe('BoundElsewhere');

	// Erasing takes the same claim an open takes, so it can only succeed in the
	// state that hands it over: a failed open released its claim before it
	// returned.
	await store.boot.eraseReplica();
	expect(held.erases()).toBe(1);
});
