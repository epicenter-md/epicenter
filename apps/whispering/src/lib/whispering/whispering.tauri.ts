import { createDesktopWorkspaceRuntime } from '@epicenter/workspace/sqlite/desktop';
import { openWhisperingApplication } from './whispering.active';

// Same infallible-module contract as the browser leaf: synchronous handles,
// operations queue behind the host's request transport, and the boot promise
// is the one fallible surface the root gate awaits.
const application = openWhisperingApplication({
	createRuntime: (onRecordsChanged) =>
		createDesktopWorkspaceRuntime({ onRecordsChanged }),
	defaultTranscriptionService: 'local',
});

export const whispering = application.whispering;
export const skills = application.skills;
export const settingsDefaults = application.settingsDefaults;
export const onWhisperingRecordsChanged = (listener: () => void) =>
	application.onRecordsChanged(whispering.id, listener);
/** Resolves when both workspaces' storage is open; rejects terminally. */
export const whisperingBoot: Promise<void> = application.whenOpen;

if (import.meta.hot) {
	import.meta.hot.dispose(() => void application[Symbol.asyncDispose]());
}
