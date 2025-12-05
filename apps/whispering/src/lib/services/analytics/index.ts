import { createAnalyticsServiceDesktop } from './desktop';
import { createAnalyticsServiceWeb } from './web';

export type { AnalyticsService, AnalyticsServiceError, Event } from './types';

export const AnalyticsServiceLive = window.__TAURI_INTERNALS__
	? createAnalyticsServiceDesktop()
	: createAnalyticsServiceWeb();
