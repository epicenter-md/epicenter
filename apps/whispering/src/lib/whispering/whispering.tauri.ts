import { createDesktopWorkspaceRuntime } from '@epicenter/workspace/sqlite/desktop';
import { openWhisperingApplication } from './whispering.active';

type WhisperingApplication = Awaited<
	ReturnType<typeof openWhisperingApplication>
>;

/**
 * Assigned when `whisperingBoot` resolves. Same infallible-module contract
 * as the browser leaf: opening the desktop workspace runtime is fallible,
 * so it happens inside the boot promise the root gate awaits, never at
 * module evaluation.
 */
export let whispering: WhisperingApplication['whispering'];
export let skills: WhisperingApplication['skills'];
export let settingsDefaults: WhisperingApplication['settingsDefaults'];
export let onWhisperingRecordsChanged: (listener: () => void) => () => void;

export const whisperingBoot: Promise<void> = (async () => {
	const application = await openWhisperingApplication({
		createRuntime: (onRecordsChanged) =>
			createDesktopWorkspaceRuntime({ onRecordsChanged }),
		defaultTranscriptionService: 'local',
	});
	whispering = application.whispering;
	skills = application.skills;
	settingsDefaults = application.settingsDefaults;
	onWhisperingRecordsChanged = (listener) =>
		application.onRecordsChanged(application.whispering.id, listener);
	if (import.meta.hot) {
		import.meta.hot.dispose(() => void application[Symbol.asyncDispose]());
	}
})();
// The gate observes boot failure through whisperingReady; without this, a
// failed boot also fires an unhandled-rejection event first.
void whisperingBoot.catch(() => undefined);
