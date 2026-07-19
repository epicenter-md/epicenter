import { services } from '$lib/services';
import type { Event } from '$lib/services/analytics/types';
import type { WhisperingApplication } from '$lib/whispering/application';

/**
 * Log an anonymous analytics event if analytics is enabled in settings.
 */
export async function logAnalyticsEvent(
	app: WhisperingApplication,
	event: Event,
): Promise<void> {
	if (!app.settings.get('analytics.enabled')) return;
	await services.analytics.logEvent(event);
}
