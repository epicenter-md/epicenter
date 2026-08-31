import { createLogger } from 'wellcrafted/logger';
import { auth } from '#platform/auth';
import { BlobsLive } from '#platform/blobs';
import {
	type WhisperingAppDependencies,
	WhisperingBackgroundError,
} from './app';

const log = createLogger('whispering/dependencies');

/**
 * The build's app dependencies. Pure data and factories: nothing here opens
 * storage or starts fallible work. The (app) layout passes this to
 * `openWhisperingApp` inside the mounted Svelte root, where the raw `{#await}`
 * owns the acquisition from its first microtask.
 *
 * `defaultTranscriptionService` used to be here and is gone. It had one value,
 * and the application owns the initialization value (`transcriptionService = 'local'`), so
 * a second declaration of it was only somewhere for the two to disagree.
 */
export const whisperingDependencies: WhisperingAppDependencies = {
	auth,
	blobs: BlobsLive,
	reportBackgroundError: (cause: unknown) =>
		log.warn(WhisperingBackgroundError.AppFailed({ cause })),
};
