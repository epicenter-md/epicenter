/**
 * Skills acquisition tests.
 *
 * These cover acquisition and release only. `createSkillsState` lives in a
 * `.svelte.ts` module, so a hydrated open needs the Svelte compiler and cannot
 * run here; every case below settles before state construction.
 */
import { expect, test } from 'bun:test';
import {
	openSkillsApplication,
	type SkillsDependencies,
} from './application.js';

type Runtime = Awaited<ReturnType<SkillsDependencies['openEpicenter']>>;

function stubRuntime() {
	let releases = 0;
	const runtime = {
		async [Symbol.asyncDispose]() {
			releases += 1;
		},
	};
	return { runtime: runtime as unknown as Runtime, releases: () => releases };
}

test('a failed Skills open rejects with its cause', async () => {
	const cause = new Error('storage unavailable');

	await expect(
		openSkillsApplication({
			async openEpicenter() {
				throw cause;
			},
			reportBackgroundError() {},
		}),
	).rejects.toBe(cause);
});

test('aborting a pending Skills open rejects before a runtime exists', async () => {
	const abort = new AbortController();
	const opening = openSkillsApplication(
		{
			openEpicenter: () => new Promise<never>(() => {}),
			reportBackgroundError() {},
		},
		{ signal: abort.signal },
	);

	abort.abort();

	await expect(opening).rejects.toHaveProperty('name', 'AbortError');
});

test('aborting just after acquisition releases the runtime it acquired', async () => {
	const abort = new AbortController();
	const stub = stubRuntime();
	const gate = Promise.withResolvers<Runtime>();

	const opening = openSkillsApplication(
		{ openEpicenter: () => gate.promise, reportBackgroundError() {} },
		{ signal: abort.signal },
	);
	// Resolve acquisition, then abort in the same tick: the resolution is
	// already queued, so the open resumes holding a runtime and trips the
	// post-acquisition abort check instead of the pending-open one.
	gate.resolve(stub.runtime);
	abort.abort();

	await expect(opening).rejects.toHaveProperty('name', 'AbortError');
	expect(stub.releases()).toBe(1);
});
