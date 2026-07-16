import { createNodeId } from '@epicenter/workspace';
import { auth } from '#platform/auth';
import { openWhisperingApplication } from './whispering.active';
import { createWhisperingBrowserRuntime } from './whispering.browser-runtime';

const nodeId = createNodeId({ storage: window.localStorage });
const application = await openWhisperingApplication({
	createRuntime(onRecordsChanged) {
		return createWhisperingBrowserRuntime({ auth, nodeId, onRecordsChanged });
	},
	defaultTranscriptionService: 'OpenAI',
});

export const whispering = application.whispering;
export const skills = application.skills;
export const settingsDefaults = application.settingsDefaults;
export const onWhisperingRecordsChanged = (listener: () => void) =>
	application.onRecordsChanged(whispering.id, listener);

if (import.meta.hot) {
	import.meta.hot.dispose(() => void application[Symbol.asyncDispose]());
}
