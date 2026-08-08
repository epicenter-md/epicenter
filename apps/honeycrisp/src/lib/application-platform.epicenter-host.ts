import { openBrowserStore } from '@epicenter/data/browser';
import { createLogger } from 'wellcrafted/logger';
import { auth } from '#platform/auth';
import type { HoneycrispDependencies } from './application.js';

const log = createLogger('honeycrisp/application');

/**
 * Dependencies for the build the desktop Epicenter host serves.
 *
 * Its own store, in its own window's private storage, for now. The host owns a
 * Bun process and `openBunStore` runs there unchanged, so the shape this build
 * eventually wants is to be a REPLICA of the host's store over the same
 * transport the cloud uses (ADR-0222). That needs an authority endpoint the
 * host does not serve yet, and inventing a second storage arrangement in the
 * meantime would be a path to delete rather than a step toward it.
 *
 * Only the host ever serves this build, and it is selected by the
 * `epicenter-host` resolve condition, so "am I hosted" is answered by which file
 * compiled and never has to be asked of the DOM at runtime (ADR-0190).
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
