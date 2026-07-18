import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { auth } from '#platform/auth';
import { createHoneycrispState } from '../routes/state/index.js';
import { createHoneycrispBrowserRuntime } from './workspace/browser.js';

const recordsChangedListeners = new Set<() => void>();

// Construction is synchronous and infallible: the handle is a real singleton
// at module scope and operations queue behind storage acquisition. Nothing
// here may top-level await storage work: a module-evaluation rejection would
// blank the page before any error surface could mount
// (scripts/check-boot-purity.ts guards this).
const runtime = createHoneycrispBrowserRuntime({
	auth,
	onRecordsChanged(workspaceId) {
		if (workspaceId !== honeycrispWorkspace.id) return;
		for (const listener of recordsChangedListeners) listener();
	},
});

const workspace = runtime.open(honeycrispWorkspace);
const state = createHoneycrispState({
	honeycrisp: workspace,
	onRecordsChanged(listener) {
		recordsChangedListeners.add(listener);
		return () => recordsChangedListeners.delete(listener);
	},
});

export const honeycrisp = {
	...workspace,
	state,
	whenReady: state.whenReady,
};

/**
 * The one fallible app bootstrap the root layout's WorkspaceGate awaits
 * before rendering anything: storage acquisition, then state hydration. A
 * failure (held storage, or any other open error) becomes a visible gate
 * screen instead of a blank page.
 */
export const honeycrispReady: Promise<void> = (async () => {
	await workspace.opened;
	await state.whenReady;
})();
// The gate is the one observer of boot failure; without these, a failed boot
// also fires unhandled-rejection events before the gate can render it
// (state hydration rejects on its own when acquisition fails, because
// honeycrispReady stops at the opened rejection and never awaits it).
void honeycrispReady.catch(() => undefined);
void state.whenReady.catch(() => undefined);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		state[Symbol.dispose]();
		recordsChangedListeners.clear();
		void runtime[Symbol.asyncDispose]();
	});
}
