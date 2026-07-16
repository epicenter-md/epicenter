import { createDesktopWorkspaceRuntime } from '@epicenter/workspace/sqlite/desktop';
import { openWhisperingApplication } from './whispering.active';

const application = await openWhisperingApplication({
	createRuntime: (onRecordsChanged) =>
		createDesktopWorkspaceRuntime({ onRecordsChanged }),
	defaultTranscriptionService: 'local',
});

export const whispering = application.whispering;
export const skills = application.skills;
export const settingsDefaults = application.settingsDefaults;
export const onWhisperingRecordsChanged = (listener: () => void) =>
	application.onRecordsChanged(whispering.id, listener);

if (import.meta.hot) {
	import.meta.hot.dispose(() => void application[Symbol.asyncDispose]());
}
