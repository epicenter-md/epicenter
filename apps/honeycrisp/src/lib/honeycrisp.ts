import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { auth } from '#platform/auth';
import { createHoneycrispState } from '../routes/state/index.js';
import { createHoneycrispBrowserRuntime } from './workspace/browser.js';

const recordsChangedListeners = new Set<() => void>();

// Runtime construction is synchronous and infallible; the fallible work
// (opening browser storage) happens inside `honeycrispReady` below.
const runtime = createHoneycrispBrowserRuntime({
	auth,
	onRecordsChanged(workspaceId) {
		if (workspaceId !== honeycrispWorkspace.id) return;
		for (const listener of recordsChangedListeners) listener();
	},
});

async function openHoneycrisp() {
	const workspace = await runtime.open(honeycrispWorkspace);
	const state = createHoneycrispState({
		honeycrisp: workspace,
		onRecordsChanged(listener) {
			recordsChangedListeners.add(listener);
			return () => recordsChangedListeners.delete(listener);
		},
	});
	return { ...workspace, state, whenReady: state.whenReady };
}

/**
 * Assigned when `honeycrispReady` resolves. Opening browser storage is
 * fallible (a suspended tab can hold the OPFS access handles), so no
 * module-evaluation code may await it: a top-level rejection here would
 * blank the page before any error surface could mount. The root layout's
 * WorkspaceGate awaits `honeycrispReady` before rendering any consumer, so
 * ordinary app code keeps importing this singleton and using it directly.
 */
export let honeycrisp: Awaited<ReturnType<typeof openHoneycrisp>>;

export const honeycrispReady: Promise<void> = (async () => {
	honeycrisp = await openHoneycrisp();
	await honeycrisp.whenReady;
})();
// The gate is the one observer of boot failure; without this, a failed boot
// also fires an unhandled-rejection event before the gate can render it.
void honeycrispReady.catch(() => undefined);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		void honeycrispReady
			.then(() => honeycrisp.state[Symbol.dispose]())
			.catch(() => undefined);
		recordsChangedListeners.clear();
		void runtime[Symbol.asyncDispose]();
	});
}
