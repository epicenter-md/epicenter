import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { auth } from '#platform/auth';
import { createHoneycrispState } from '../routes/state/index.js';
import { createHoneycrispBrowserRuntime } from './workspace/browser.js';

const recordsChangedListeners = new Set<() => void>();

const runtime = createHoneycrispBrowserRuntime({
	auth,
	onRecordsChanged(workspaceId) {
		if (workspaceId !== honeycrispWorkspace.id) return;
		for (const listener of recordsChangedListeners) listener();
	},
});

const workspace = await runtime.open(honeycrispWorkspace);
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

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		state[Symbol.dispose]();
		recordsChangedListeners.clear();
		void runtime[Symbol.asyncDispose]();
	});
}
