import { authClient } from '#platform/auth';
import { BlobsLive } from '#platform/blobs';
import type { WhisperingAppDependencies } from './app';

/**
 * The build's app dependencies. Pure data and factories: nothing here opens
 * storage or starts fallible work. The (app) layout passes this to
 * `openWhisperingApp` inside the mounted Svelte root, where the raw `{#await}`
 * owns the acquisition from its first microtask.
 *
 * `defaultTranscriptionService` used to be here and is gone. It had one value,
 * and the application owns the initialization value (`transcriptionService = 'local'`), so
 * a second declaration of it was only somewhere for the two to disagree.
 *
 * `reportBackgroundError` went the same way. Its one consumer was the sync
 * transport callback this file's opener passed down, and the opener is
 * `@epicenter/app`'s now (ADR-0339): a dial that fails is warned about there,
 * beside every other application that opens a store, rather than by a
 * dependency each one declares.
 */
export const whisperingDependencies: WhisperingAppDependencies = {
	auth: authClient,
	blobs: BlobsLive,
};
