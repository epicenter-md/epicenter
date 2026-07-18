import { auth } from '#platform/auth';
import { openWhisperingApplication } from './whispering.active';
import { createWhisperingBrowserRuntime } from './whispering.browser-runtime';

// Construction is synchronous and infallible: handles are real singletons at
// module scope, operations queue behind storage acquisition, and the one
// fallible thing (`whisperingBoot`) is a promise the root layout's
// WorkspaceGate awaits. Nothing here may top-level await storage work: a
// module-evaluation rejection would blank the page before any error surface
// could mount (scripts/check-boot-purity.ts guards this).
const application = openWhisperingApplication({
	createRuntime(onRecordsChanged) {
		return createWhisperingBrowserRuntime({ auth, onRecordsChanged });
	},
	defaultTranscriptionService: 'OpenAI',
});

export const whispering = application.whispering;
export const skills = application.skills;
export const settingsDefaults = application.settingsDefaults;
export const onWhisperingRecordsChanged = (listener: () => void) =>
	application.onRecordsChanged(whispering.id, listener);
/** Resolves when both workspaces' storage is open; rejects terminally. */
export const whisperingBoot: Promise<void> = application.opened;

if (import.meta.hot) {
	import.meta.hot.dispose(() => void application[Symbol.asyncDispose]());
}
