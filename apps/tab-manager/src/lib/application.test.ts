/**
 * Tab Manager application lifecycle tests.
 *
 * Why these matter more here than in a web app: the side panel is opened and
 * closed constantly, and each open acquires one exclusive Web Lock over one OPFS
 * SQLite file (ADR-0165/ADR-0177). A path that fails or aborts without releasing
 * the runtime does not just leak memory: it makes every later open of the panel
 * refuse, until the browser restarts. So the release paths are asserted:
 *
 * - a failed hydration releases the runtime it opened
 * - aborting a pending hydration rejects and releases
 * - a runtime that arrives after release has already happened is still disposed
 */

/// <reference types="bun" />

import { expect, mock, test } from 'bun:test';

// Runes are compiler macros; nothing compiles this file, so stand them up as
// identity functions the way the other application tests in this repo do.
(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);

// The extension globals and the two app-shell surfaces that would otherwise drag
// an inference engine and a Chrome event graph into a lifecycle test.
//
// `browser-state.svelte.ts` registers its Chrome listeners at module scope, so
// importing the application at all requires a `browser` that answers every
// `on*` event. A Proxy covers them without this test having to track which
// events that module happens to watch today.
const chromeNamespace = () =>
	new Proxy(
		{},
		{
			get: (_target, property) =>
				typeof property === 'string' && property.startsWith('on')
					? { addListener() {}, removeListener() {} }
					: async () => [],
		},
	);
(globalThis as unknown as { browser: unknown }).browser = new Proxy(
	{},
	{
		get: (_target, property) =>
			property === 'runtime'
				? { getPlatformInfo: async () => ({ os: 'mac' }) }
				: chromeNamespace(),
	},
);
mock.module('@wxt-dev/storage', () => ({
	storage: {
		defineItem: () => ({
			getValue: async () => null,
			setValue: async () => {},
			removeValue: async () => {},
			watch: () => () => {},
		}),
	},
}));
mock.module('@epicenter/app-shell/agent-chat', () => ({
	createAgentChatState: () => ({ [Symbol.dispose]() {} }),
}));
mock.module('@epicenter/app-shell/inference-picker', () => ({
	createInferenceConnections: () => ({}),
}));

const { openTabManagerApplication } = await import('./application.js');

/**
 * A fake runtime whose tables fail or hang on read, so hydration is the thing
 * under test. `releases` is what the assertions actually care about.
 */
function createRuntime(scan: () => Promise<never>) {
	let releases = 0;
	const table = {
		scan,
		subscribe: () => () => {},
		openDocument: async () => ({}),
	};
	return {
		get releases() {
			return releases;
		},
		value: {
			auth: { fetch: async () => new Response() },
			instanceSetting: {},
			profile: { nodeId: 'test-node', defaultName: 'Chrome on macOS' },
			epicenter: {
				bind: () => ({
					tables: {
						devices: table,
						savedTabs: table,
						bookmarks: table,
						toolTrust: table,
						conversations: table,
					},
					values: {},
				}),
				syncStatus: { state: 'local', lastError: undefined },
				subscribeSyncStatus: () => () => {},
			},
			async [Symbol.asyncDispose]() {
				releases += 1;
			},
		} as never,
	};
}

test('a failed hydration releases the replica it opened', async () => {
	const cause = new Error('storage unavailable');
	const runtime = createRuntime(() => Promise.reject(cause));

	await expect(
		openTabManagerApplication({
			openRuntime: async () => runtime.value,
			reportBackgroundError() {},
		}),
	).rejects.toBe(cause);

	expect(runtime.releases).toBe(1);
});

test('aborting a pending hydration rejects and releases the replica', async () => {
	const abort = new AbortController();
	const runtime = createRuntime(() => new Promise<never>(() => {}));
	const opening = openTabManagerApplication(
		{
			openRuntime: async () => runtime.value,
			reportBackgroundError() {},
		},
		{ signal: abort.signal },
	);

	await new Promise((resolve) => setTimeout(resolve, 0));
	abort.abort();
	await expect(opening).rejects.toHaveProperty('name', 'AbortError');
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(runtime.releases).toBe(1);
});

test('a replica that finishes opening after an abort is still released', async () => {
	// The window that actually strands a Web Lock: the panel closes while
	// `openRuntime` is still in flight, so release runs before there is anything
	// to release. The late arrival has to dispose itself.
	const abort = new AbortController();
	const runtime = createRuntime(() => new Promise<never>(() => {}));
	const acquisition = Promise.withResolvers<never>();
	const opening = openTabManagerApplication(
		{
			openRuntime: () =>
				acquisition.promise.then(() => runtime.value) as Promise<never>,
			reportBackgroundError() {},
		},
		{ signal: abort.signal },
	);

	abort.abort();
	await expect(opening).rejects.toHaveProperty('name', 'AbortError');
	acquisition.resolve(undefined as never);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(runtime.releases).toBe(1);
});
