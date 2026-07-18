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
	): OpenedWorkspace<TDefinition>;
	whenOpen(workspaceId: string): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Bind the two imported workspace contracts used by Whispering through one
 * environment-owned runtime. Ordinary application code composes the returned
 * handles; neither workspace definition knows about the other.
 *
 * Construction is synchronous and infallible: `open` returns stable handles
 * whose operations queue behind the runtime's storage acquisition, and
 * `whenOpen` is the one fallible readiness promise the boot gate awaits.
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
	const whenOpen = Promise.all([
		runtime.whenOpen(whisperingWorkspace.id),
		runtime.whenOpen(skillsWorkspace.id),
	]).then(() => undefined);
	// The boot gate is the observer; without this, a failed acquisition also
	// fires an unhandled-rejection event before the gate can render it.
	void whenOpen.catch(() => undefined);

	return Object.freeze({
		whispering,
		skills,
		whenOpen,
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
