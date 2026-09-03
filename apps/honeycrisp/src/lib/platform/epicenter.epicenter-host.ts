/**
 * `#platform/epicenter` for the trusted Epicenter origin.
 *
 * A Bun-owned file below the Epicenter data root, and a keychain entry over the
 * private sidecar pipe. Honeycrisp owns no file and keeps no secret today, and
 * still takes the owner its platform actually has: a build that quietly held
 * tab memory here would be a durability difference nothing could observe until
 * something needed it.
 *
 * Selected by the `epicenter-host` build condition, never by a runtime test:
 * this page runs in a WebView, so nothing observable at runtime tells it apart
 * from a browser tab.
 */

import { createDesktopEpicenter } from '@epicenter/app/desktop';
import { fromEpicenter } from '@epicenter/svelte';
import { auth } from '#platform/auth';
import { honeycrispDefinition } from '$lib/data/index.js';

const handle = createDesktopEpicenter({
	appId: honeycrispDefinition.id,
	definition: honeycrispDefinition,
	account: auth,
});

export const epicenter = fromEpicenter(handle);

if (import.meta.hot) {
	import.meta.hot.dispose(() => void handle.close());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
