import { createLogger } from 'wellcrafted/logger';
import { auth } from '#platform/auth';
import { BlobsLive } from '#platform/blobs';
import {
	type WhisperingAppDependencies,
	WhisperingBackgroundError,
} from './app';
import { openWhisperingBrowserEpicenter } from './whispering.browser-runtime';

const log = createLogger('whispering/browser');

/**
 * The web build's app dependencies. Pure data and factories: nothing
 * here opens storage or starts fallible work. The (app) layout passes this to
 * `openWhisperingApp` inside the mounted Svelte root, where the raw
 * `{#await}` owns the acquisition from its first microtask.
 */
export const whisperingPlatform: WhisperingAppDependencies = {
	openEpicenter: () =>
		openWhisperingBrowserEpicenter({
			auth,
			reportBackgroundError: (cause) =>
				log.warn(WhisperingBackgroundError.SyncFailed({ cause })),
		}),
	blobs: BlobsLive,
	defaultTranscriptionService: 'OpenAI',
	reportBackgroundError: (cause) =>
		log.warn(WhisperingBackgroundError.AppFailed({ cause })),
};
