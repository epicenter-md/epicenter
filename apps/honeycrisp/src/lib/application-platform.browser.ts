import { createLogger } from 'wellcrafted/logger';
import { auth } from '#platform/auth';
import {
	HoneycrispBackgroundError,
	type HoneycrispDependencies,
} from './application.js';
import { openHoneycrispBrowserEpicenter } from './workspace/browser.js';

const log = createLogger('honeycrisp/application');

/**
 * Dependencies for every build that owns its own replica: the hosted web SPA
 * and the standalone desktop bundle alike. A WebView is a storage partition and
 * origin pair like any other (ADR-0177), so both open browser storage, carry
 * their own credential, and attach their own sync.
 *
 * Inert: storage does not open until the root calls open.
 */
export const honeycrispPlatform: HoneycrispDependencies = {
	openEpicenter: () =>
		openHoneycrispBrowserEpicenter({
			auth,
			reportBackgroundError: (cause) =>
				log.warn(HoneycrispBackgroundError.SyncFailed({ cause })),
		}),
	reportBackgroundError: (cause) =>
		log.warn(HoneycrispBackgroundError.RefreshFailed({ cause })),
};
