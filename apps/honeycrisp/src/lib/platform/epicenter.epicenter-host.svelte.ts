/**
 * `#platform/epicenter` for the trusted Epicenter origin.
 *
 * The one thing this application reaches its notes through. Two functions
 * composed: `createEpicenter` knows nothing about Svelte, `fromEpicenter`
 * adapts it, and the composition happens here because this file is where both
 * axes are already decided (ADR-0339, ADR-0340).
 *
 * The runtime is the import path, never a runtime test: a WebView cannot be
 * told from a tab by anything observable at runtime, so the build answers it.
 *
 * `definition` and `account` arrive together, which is the store: an authority
 * mints every generation (ADR-0336), so there is no accountless notebook.
 * There is no application id, because the definition is one: this application
 * holds its own notes and nobody else's.
 *
 * **Nothing opens when this module is evaluated.** Both halves are lazy, so a
 * route that never renders the notes never claims a Web Lock, touches
 * IndexedDB, or makes a round trip: `/auth/callback` imports its own auth leaf
 * and never reads `state`.
 */

import { createEpicenter } from '@epicenter/app/desktop';
import { fromEpicenter } from '@epicenter/svelte';
import { auth } from '#platform/auth';
import { honeycrispDefinition } from '$lib/data/index.js';

const epicenter = createEpicenter({
	definition: honeycrispDefinition,
	account: auth,
});

export const honeycrisp = fromEpicenter(epicenter);

// A hot swap of this module builds a second handle, and the first one still
// holds the Web Lock its store claimed, so the replacement would open into
// `AlreadyOpen` until the page was reloaded by hand. Closing is terminal and
// releases all three things opening took; the new module opens fresh. The auth
// leaf next door disposes for the same reason.
if (import.meta.hot) {
	import.meta.hot.dispose(() => void epicenter.close());
}
