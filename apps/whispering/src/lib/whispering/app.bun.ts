import { createDeviceBunWorkspaceRuntime } from '@epicenter/workspace/sqlite/bun';
import { consoleSink, type LogEvent } from 'wellcrafted/logger';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import type { WhisperingAppDependencies } from './app';

export type CreateWhisperingBunDependenciesOptions = {
	workspacesRoot: string;
	defaultTranscriptionService?: TranscriptionServiceId;
};

/**
 * Native dependencies for scripts and long-lived local agent hosts.
 * Construction is inert; SQLite opens only when the caller awaits
 * `openWhisperingApp`.
 */
export function createWhisperingBunDependencies({
	workspacesRoot,
	defaultTranscriptionService = 'local',
}: CreateWhisperingBunDependenciesOptions): WhisperingAppDependencies {
	return {
		createRuntime: (onRecordsChanged) =>
			createDeviceBunWorkspaceRuntime({ workspacesRoot, onRecordsChanged }),
		defaultTranscriptionService,
		reportBackgroundError(cause) {
			consoleSink({
				ts: Date.now(),
				level: 'error',
				source: 'whispering/app',
				message: 'Whispering app background failure',
				data: cause,
			} satisfies LogEvent);
		},
	};
}
