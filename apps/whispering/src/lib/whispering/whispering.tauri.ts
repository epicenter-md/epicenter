import { createDesktopWorkspaceRuntime } from '@epicenter/workspace/sqlite/desktop';
import { log } from '$lib/report';
import type { WhisperingDependencies } from './application';

/**
 * The Epicenter-hosted build's application dependencies. Pure data and
 * factories: the WebView runtime performs its honest host open handshake only
 * once `openWhisperingApplication` runs inside the mounted Svelte root.
 */
export const whisperingPlatform: WhisperingDependencies = {
	createRuntime: (onRecordsChanged) =>
		createDesktopWorkspaceRuntime({ onRecordsChanged }),
	defaultTranscriptionService: 'local',
	reportBackgroundError: (cause) =>
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering application background failure',
		),
};
