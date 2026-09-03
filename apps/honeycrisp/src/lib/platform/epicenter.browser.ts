/**
 * `#platform/epicenter` for the web and standalone builds.
 *
 * OPFS files and secrets that live exactly as long as the tab (ADR-0310).
 * The leaf owns the complete application surface: runtime construction,
 * account and definition composition, Svelte adaptation, and hot-reload
 * disposal. The other leaf has the same shape with a different owner.
 *
 */

import { createBrowserEpicenter } from '@epicenter/app/browser';
import { fromEpicenter } from '@epicenter/svelte';
import { auth } from '#platform/auth';
import { honeycrispDefinition } from '$lib/data/index.js';

const handle = createBrowserEpicenter({
	appId: honeycrispDefinition.id,
	definition: honeycrispDefinition,
	account: auth,
});

export const epicenter = fromEpicenter(handle);

if (import.meta.hot) {
	import.meta.hot.dispose(() => void handle.close());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
