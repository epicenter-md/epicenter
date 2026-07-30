import { expect, test } from 'bun:test';

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = <TValue>(
	value: TValue,
) => value;

const { openSkillsApplication } = await import('./application.js');

test('a failed Skills open releases its runtime', async () => {
	const cause = new Error('storage unavailable');
	let releases = 0;

	await expect(
		openSkillsApplication({
			openEpicenter: async () =>
				({
					bind() {
						return {
							tables: {
								skills: {
									subscribe: () => () => {},
									scan: () => Promise.reject(cause),
								},
								skillReferences: {
									subscribe: () => () => {},
									scan: () => new Promise<never>(() => {}),
								},
							},
							values: {},
						};
					},
					async [Symbol.asyncDispose]() {
						releases += 1;
					},
				}) as never,
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
			openEpicenter: async () =>
				({
					bind() {
						const table = {
							subscribe: () => () => {},
							scan: () => new Promise<never>(() => {}),
						};
						return {
							tables: { skills: table, skillReferences: table },
							values: {},
						};
					},
					async [Symbol.asyncDispose]() {
						releases += 1;
					},
				}) as never,
			reportBackgroundError() {},
		},
		{ signal: abort.signal },
	);

	await new Promise((resolve) => setTimeout(resolve, 0));
	abort.abort();
	await expect(opening).rejects.toHaveProperty('name', 'AbortError');
	expect(releases).toBe(1);
});

test('abort wins acquisition and releases a runtime that opens late', async () => {
	const gate = Promise.withResolvers<void>();
	const abort = new AbortController();
	let releases = 0;
	const opening = openSkillsApplication(
		{
			openEpicenter: async () => {
				await gate.promise;
				return {
					bind() {
						throw new Error('a late runtime must not be bound');
					},
					async [Symbol.asyncDispose]() {
						releases += 1;
					},
				} as never;
			},
			reportBackgroundError() {},
		},
		{ signal: abort.signal },
	);

	abort.abort(new Error('root unmounted'));
	await expect(opening).rejects.toThrow('root unmounted');
	gate.resolve();
	while (releases === 0) await Bun.sleep(1);
	expect(releases).toBe(1);
});
