import { onMount } from 'svelte';
import { analytics } from '$lib/operations/analytics';

/** Log the one `app_started` analytics event per launch, once mounted. */
export function logAppStarted(): void {
	onMount(() => {
		analytics.logEvent({ type: 'app_started' });
	});
}
