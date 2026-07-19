import { auth } from '#platform/auth';
import { BlobsLive } from '#platform/blobs';
import { log } from '$lib/report';
import type { WhisperingAppDependencies } from './app';
import { createWhisperingBrowserRuntime } from './whispering.browser-runtime';

/**
 * The web build's app dependencies. Pure data and factories: nothing
 * here opens storage or starts fallible work. The (app) layout passes this to
 * `openWhisperingApp` inside the mounted Svelte root, where the raw
 * `{#await}` owns the acquisition from its first microtask.
 */
export const whisperingPlatform: WhisperingAppDependencies = {
	createRuntime: (onRecordsChanged) =>
		createWhisperingBrowserRuntime({ auth, onRecordsChanged }),
	blobs: BlobsLive,
	defaultTranscriptionService: 'OpenAI',
	reportBackgroundError: (cause) =>
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering app background failure',
		),
};
