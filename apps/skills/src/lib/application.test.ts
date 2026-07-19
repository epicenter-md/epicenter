import { expect, test } from 'bun:test';
import { openSkillsApplication } from './application.js';

test('a failed Skills open releases its runtime', async () => {
	const cause = new Error('storage unavailable');
	let releases = 0;

	await expect(
		openSkillsApplication({
			createRuntime: () => ({
				async open() {
					throw cause;
				},
				async [Symbol.asyncDispose]() {
					releases += 1;
				},
			}),
			reportBackgroundError() {},
		}),
	).rejects.toBe(cause);

	expect(releases).toBe(1);
});

test('aborting a pending Skills open rejects and releases its runtime', async () => {
	const abort = new AbortController();
	let releases = 0;
	const opening = openSkillsApplication(
		{
			createRuntime: () => ({
				open: () => new Promise<never>(() => {}),
				async [Symbol.asyncDispose]() {
					releases += 1;
				},
			}),
			reportBackgroundError() {},
		},
		{ signal: abort.signal },
	);

	abort.abort();
	await expect(opening).rejects.toHaveProperty('name', 'AbortError');
	expect(releases).toBe(1);
});
