import { expect, mock, test } from 'bun:test';

mock.module('$app/navigation', () => ({ goto: mock() }));
mock.module('$app/state', () => ({
	page: { url: new URL('https://honeycrisp.local/') },
}));

const { openHoneycrispApplication } = await import('./application.js');

test('a failed Honeycrisp open releases its runtime', async () => {
	const cause = new Error('storage unavailable');
	let releases = 0;

	await expect(
		openHoneycrispApplication({
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

test('aborting a pending Honeycrisp open rejects and releases its runtime', async () => {
	const abort = new AbortController();
	let releases = 0;
	const opening = openHoneycrispApplication(
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
