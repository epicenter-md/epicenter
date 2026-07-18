import { auth } from '#platform/auth';
import { openWhisperingApplication } from './whispering.active';
import { createWhisperingBrowserRuntime } from './whispering.browser-runtime';

type WhisperingApplication = Awaited<
	ReturnType<typeof openWhisperingApplication>
>;

/**
 * Assigned when `whisperingBoot` resolves. Opening browser storage is
 * fallible (a suspended tab can hold the OPFS access handles), so no
 * module-evaluation code may await it: a top-level rejection would blank
 * the page before any error surface could mount. The root layout's
 * WorkspaceGate blocks every consumer until the composed app boot resolves.
 */
export let whispering: WhisperingApplication['whispering'];
export let skills: WhisperingApplication['skills'];
export let settingsDefaults: WhisperingApplication['settingsDefaults'];
export let onWhisperingRecordsChanged: (listener: () => void) => () => void;

export const whisperingBoot: Promise<void> = (async () => {
	const application = await openWhisperingApplication({
		createRuntime(onRecordsChanged) {
			return createWhisperingBrowserRuntime({ auth, onRecordsChanged });
		},
		defaultTranscriptionService: 'OpenAI',
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
