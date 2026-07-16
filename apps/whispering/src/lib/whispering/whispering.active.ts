import { skillsWorkspace } from '@epicenter/skills';
import type {
	OpenedWorkspace,
	WorkspaceDefinition,
} from '@epicenter/workspace/sqlite';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import {
	createWhisperingSettingDefaults,
	whisperingWorkspace,
} from '../workspace';

type ApplicationRuntime = {
	open<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
	): Promise<OpenedWorkspace<TDefinition>>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Bind the two imported workspace contracts used by Whispering through one
 * environment-owned runtime. Ordinary application code composes the returned
 * handles; neither workspace definition knows about the other.
 */
export async function openWhisperingApplication({
	createRuntime,
	defaultTranscriptionService,
}: {
	createRuntime(
		onRecordsChanged: (workspaceId: string) => void,
	): ApplicationRuntime;
	defaultTranscriptionService: TranscriptionServiceId;
}) {
	const recordListeners = new Map<string, Set<() => void>>();
	const runtime = createRuntime((workspaceId) => {
		for (const listener of recordListeners.get(workspaceId) ?? []) listener();
	});
	const [whispering, skills] = await Promise.all([
		runtime.open(whisperingWorkspace),
		runtime.open(skillsWorkspace),
	]);

	return Object.freeze({
		whispering,
		skills,
		settingsDefaults: createWhisperingSettingDefaults(
			defaultTranscriptionService,
		),
		onRecordsChanged(workspaceId: string, listener: () => void) {
			let listeners = recordListeners.get(workspaceId);
			if (!listeners) {
				listeners = new Set();
				recordListeners.set(workspaceId, listeners);
			}
			listeners.add(listener);
			return () => listeners?.delete(listener);
		},
		async [Symbol.asyncDispose]() {
			recordListeners.clear();
			await runtime[Symbol.asyncDispose]();
		},
	});
}
