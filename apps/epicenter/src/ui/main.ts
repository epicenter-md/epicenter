/** Query waits for Tauri's in-memory bootstrap before touching host APIs. */

import '@epicenter/ui/app.css';
import { mount } from 'svelte';
import App from './App.svelte';

declare global {
	interface Window {
		__EPICENTER_SESSION_READY__?: Promise<void>;
	}
}

const sessionReady =
	window.__EPICENTER_SESSION_READY__ ??
	Promise.reject(new Error('Query must be opened by Epicenter.'));

mount(App, {
	// biome-ignore lint/style/noNonNullAssertion: index.html always ships the mount node.
	target: document.getElementById('app')!,
	props: { sessionReady },
});
