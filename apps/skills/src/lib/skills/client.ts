import { skillsWorkspace } from '@epicenter/skills';
import { createBrowserWorkspaceRuntime } from '@epicenter/workspace/sqlite/browser';

const recordsChangedListeners = new Set<() => void>();

export const skillsRuntime = createBrowserWorkspaceRuntime({
	authorityKey: 'skills-local-device',
	onRecordsChanged(workspaceId) {
		if (workspaceId !== skillsWorkspace.id) return;
		for (const listener of recordsChangedListeners) listener();
	},
});

export const skills = await skillsRuntime.open(skillsWorkspace);

export function onSkillsRecordsChanged(listener: () => void): () => void {
	recordsChangedListeners.add(listener);
	return () => recordsChangedListeners.delete(listener);
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		recordsChangedListeners.clear();
		void skillsRuntime[Symbol.asyncDispose]();
	});
}
