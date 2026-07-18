import { skillsWorkspace } from '@epicenter/skills';
import type {
	WorkspaceDefinition,
	WorkspaceHandle,
} from '@epicenter/workspace/sqlite';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import {
	createWhisperingSettingDefaults,
	whisperingWorkspace,
} from '../workspace';

type ApplicationRuntime = {
	open<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
	): WorkspaceHandle<TDefinition>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Bind the two imported workspace contracts used by Whispering through one
 * environment-owned runtime. Ordinary application code composes the returned
 * handles; neither workspace definition knows about the other.
 *
 * Construction is synchronous and infallible: `open` returns stable handles
 * whose operations queue behind the runtime's storage acquisition. Their
 * `opened` promises are the one fallible boundary the boot gate awaits.
 */
export function openWhisperingApplication({
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
	const whispering = runtime.open(whisperingWorkspace);
	const skills = runtime.open(skillsWorkspace);
	const opened = Promise.all([whispering.opened, skills.opened]).then(
		() => undefined,
	);
	// The boot gate is the observer; without this, a failed acquisition also
	// fires an unhandled-rejection event before the gate can render it.
	void opened.catch(() => undefined);

	return Object.freeze({
		whispering,
		skills,
		opened,
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
