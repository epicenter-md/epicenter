import { createDesktopWorkspaceRuntime } from '@epicenter/workspace/sqlite/desktop';
import { BlobsLive } from '#platform/blobs';
import { log } from '$lib/report';
import type { WhisperingAppDependencies } from './app';

/**
 * The Epicenter-hosted build's app dependencies. Pure data and
 * factories: the WebView runtime performs its honest host open handshake only
 * once `openWhisperingApp` runs inside the mounted Svelte root.
 */
export const whisperingPlatform: WhisperingAppDependencies = {
	createRuntime: (onRecordsChanged) =>
		createDesktopWorkspaceRuntime({ onRecordsChanged }),
	blobs: BlobsLive,
	defaultTranscriptionService: 'local',
	reportBackgroundError: (cause) =>
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering app background failure',
		),
};
