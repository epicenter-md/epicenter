import { services } from '$lib/services';
import type { Event } from '$lib/services/analytics/types';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * Log an anonymous analytics event if analytics is enabled in settings.
 */
export async function logAnalyticsEvent(
	app: WhisperingApp,
	event: Event,
): Promise<void> {
	if (!app.settings.get('analytics.enabled')) return;
	await services.analytics.logEvent(event);
}
