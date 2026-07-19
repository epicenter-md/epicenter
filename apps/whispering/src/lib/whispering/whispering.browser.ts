import { auth } from '#platform/auth';
import { log } from '$lib/report';
import type { WhisperingDependencies } from './application';
import { createWhisperingBrowserRuntime } from './whispering.browser-runtime';

/**
 * The web build's application dependencies. Pure data and factories: nothing
 * here opens storage or starts fallible work. The (app) layout passes this to
 * `openWhisperingApplication` inside the mounted Svelte root, where the raw
 * `{#await}` owns the acquisition from its first microtask.
 */
export const whisperingPlatform: WhisperingDependencies = {
	createRuntime: (onRecordsChanged) =>
		createWhisperingBrowserRuntime({ auth, onRecordsChanged }),
	defaultTranscriptionService: 'OpenAI',
	reportBackgroundError: (cause) =>
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering application background failure',
		),
};
