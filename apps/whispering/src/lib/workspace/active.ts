import { createNodeId } from '@epicenter/workspace';
import { defaultTranscriptionService, environment } from '#environment';
import { openWhisperingBrowser } from './browser';

/**
 * The always-available Whispering workspace for this application boot.
 * Authentication chooses its connection once; it never gates workspace access.
 */
export const whispering = openWhisperingBrowser({
	auth: environment.auth,
	nodeId: createNodeId({ storage: window.localStorage }),
	defaultTranscriptionService,
});
