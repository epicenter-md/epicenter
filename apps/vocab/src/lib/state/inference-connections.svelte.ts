/**
 * Vocab's device-local inference connection registry (ADR-0059).
 *
 * One shared registry (built once here) that the header picker, the engine, and
 * the cross-device banner all read. Hosted is Vocab's one curated model
 * (`VOCAB_MODEL`); custom connections and their discovered models live in
 * localStorage, never synced (a key is a secret and a `localhost` URL is
 * meaningless elsewhere, ADR-0004).
 */

import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { VOCAB_MODEL } from '$lib/data';
import { auth } from '$lib/platform/auth';

export const inferenceConnections = createInferenceConnections({
	storageKey: 'vocab',
	hostedModels: toHostedCatalog([VOCAB_MODEL]),
	hosted: {
		fetch: auth.fetch,
		baseURL: API_ROUTES.ai.baseUrl(APP_URLS.API),
	},
	persist: (key, schema, defaultValue) =>
		createPersistedState({ key, schema, defaultValue }),
});
