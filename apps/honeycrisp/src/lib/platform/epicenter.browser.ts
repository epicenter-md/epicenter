/**
 * `#platform/epicenter` for the web and standalone builds.
 *
 * The one handle this application reaches its notes through (ADR-0339). The
 * runtime is the import path, never a runtime test: a WebView cannot be told
 * from a tab by anything observable at runtime, so the build answers it.
 *
 * `definition` and `account` arrive together, which is the store: an authority
 * mints every generation (ADR-0336), so there is no accountless notebook. The
 * account is the client this build composed, and passing it here is what
 * attaches sync. There is no application id, because the definition is one:
 * this application holds its own notes and nobody else's.
 *
 * Nothing opens yet. `epicenter.data` is a lazy getter, so a signed-out person
 * meeting the gate pays no Web Lock, no IndexedDB, and no round trip.
 */

import { createEpicenter } from '@epicenter/app/browser';
import { auth } from '#platform/auth';
import { honeycrispDefinition } from '$lib/data/index.js';

export const epicenter = createEpicenter({
	definition: honeycrispDefinition,
	account: auth,
});
