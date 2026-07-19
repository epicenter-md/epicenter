import { onMount } from 'svelte';
import { logAnalyticsEvent } from '$lib/operations/analytics';
import type { WhisperingApplication } from '$lib/whispering/application';

/** Log the one `app_started` analytics event per launch, once mounted. */
export function logAppStarted(app: WhisperingApplication): void {
	onMount(() => {
		void logAnalyticsEvent(app, { type: 'app_started' });
	});
}
