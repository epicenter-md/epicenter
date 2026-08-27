/**
 * Vocab's device-local inference connection registry (ADR-0059).
 *
 * One shared registry (built once here) that the header picker, the engine, and
 * the cross-device banner all read. Hosted is Vocab's one curated model
 * (`VOCAB_MODEL`), offered only on a Cloud-bound device; custom connections and
 * their discovered models live in localStorage, never synced (a key is a secret
 * and a `localhost` URL is meaningless elsewhere, ADR-0004).
 */

import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import { hostedCatalogFor } from '@epicenter/constants/hosted-catalog';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { VOCAB_MODEL, VOCAB_STT_MODEL } from '@epicenter/vocab';
import { instanceSetting } from '$lib/instance';
import { auth } from '$lib/platform/auth';

export const inferenceConnections = createInferenceConnections({
	storageKey: 'vocab',
	hostedModels: hostedCatalogFor([VOCAB_MODEL]),
	// Cloud's STT model rides the same Connection base as chat but is not a model
	// anyone picks, so it is declared rather than listed in the picker. Previously
	// dictation reached it only via a hosted fallback, which made an accident of a
	// dependency.
	hostedAlsoServes: [VOCAB_STT_MODEL],
	// Cloud's gateway only, and only when this device is bound to Cloud. On a
	// self-host session `auth.fetch` carries the instance token, which is the wrong
	// audience for Cloud's URL (ADR-0053), and the instance serves no models of its
	// own (ADR-0264). Omitting it drops the group from the picker instead of
	// offering an entry that 401s.
	hosted: instanceSetting.isDefault()
		? { fetch: auth.fetch, baseURL: API_ROUTES.ai.baseUrl(APP_URLS.API) }
		: undefined,
	persist: (key, schema, defaultValue) =>
		createPersistedState({ key, schema, defaultValue }),
});
