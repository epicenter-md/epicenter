/**
 * The one thing this application reaches its notes through.
 *
 * Two functions composed: `createEpicenter` knows nothing about Svelte,
 * `fromEpicenter` adapts it, and what comes back is the same epicenter with its
 * store rendered as a boot (ADR-0339, ADR-0340).
 *
 * **This file is not a platform leaf, and there is one of it.** Nothing about
 * an epicenter varies by runtime: the store is client-owned in every build
 * (ADR-0226, ADR-0227), the definition is one file, and the account is already
 * selected next door. What varies is a Bun-owned file and a keychain, so that
 * is what `#platform/binding` selects and all that it holds. The wiring, the
 * singleton, and the one call that ends it live here, in one copy, where they
 * cannot drift between two leaves that differ on an import line.
 *
 * `definition` and `account` arrive together, which is the store: an authority
 * mints every generation (ADR-0336), so there is no accountless notebook. The
 * explicit application id matches the definition here, but remains the
 * opening application's independent storage scope (ADR-0324).
 *
 * **Nothing opens when this module is evaluated.** Both halves are lazy, so a
 * route that never renders the notes never claims a Web Lock, touches
 * IndexedDB, or makes a round trip: `/auth/callback` imports its own auth leaf
 * and never reads `boot`.
 */

import { createEpicenter } from '@epicenter/app';
import { fromEpicenter } from '@epicenter/svelte';
import { auth } from '#platform/auth';
import { binding } from '#platform/binding';
import { honeycrispDefinition } from '$lib/data/index.js';

/**
 * The handle, module-private, because `close` is on it.
 *
 * Ending the store is the page's, and the one caller that needs a lifetime
 * shorter than a document is the hot reload three lines below. Keeping the
 * handle here is what makes that the only reachable caller: what the
 * application imports is the boot, which has no close on it at all.
 */
const handle = createEpicenter({
	appId: honeycrispDefinition.id,
	definition: honeycrispDefinition,
	account: auth,
	binding,
});

export const epicenter = fromEpicenter(handle);

// A hot swap of this module builds a second handle while the first still holds
// the Web Lock its store claimed, so the replacement opens into `AlreadyOpen`
// until the page is reloaded by hand. Closing is terminal and releases all
// three things opening took, so the new module opens fresh.
//
// `accept` is what makes the `dispose` run. Vite disposes only the module an
// update was ACCEPTED at (`fetchUpdate` in its client), and a module with no
// `accept` is never one: the update walks up to the nearest self-accepting
// importer, which is the page component, and the page's disposer runs instead
// of this one. Accepting makes this its own boundary; invalidating immediately
// says it cannot really handle the swap, so the update goes on up to the page
// exactly as it did before, with the old handle now closed.
if (import.meta.hot) {
	import.meta.hot.dispose(() => void handle.close());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
