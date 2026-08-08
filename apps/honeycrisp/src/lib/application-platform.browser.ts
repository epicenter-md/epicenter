import { openBrowserStore } from '@epicenter/data/browser';
import { createLogger } from 'wellcrafted/logger';
import { auth } from '#platform/auth';
import type { HoneycrispDependencies } from './application.js';

const log = createLogger('honeycrisp/application');

/**
 * Dependencies for every build that owns its own store: the hosted web SPA and
 * the standalone desktop bundle alike. A WebView is a storage partition and
 * origin pair like any other (ADR-0177), so both open browser storage.
 *
 * Inert: nothing opens until the root calls it.
 */
export const honeycrispPlatform: HoneycrispDependencies = {
	async openStore() {
		const { data, error } = await openBrowserStore({ name: 'honeycrisp' });
		if (error !== null) throw error;
		return data;
	},
	auth,
	reportBackgroundError: (cause) =>
		log.warn(new Error('Honeycrisp background work failed', { cause })),
};
