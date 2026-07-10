import { createNodeId } from '@epicenter/workspace';
import {
	baseEnvironment,
	defaultTranscriptionService,
} from '#environment-base';
import { openWhisperingBrowser } from './browser';

/**
 * The always-available Whispering workspace for this application boot.
 * Authentication chooses its connection once; it never gates workspace access.
 */
export const whispering = openWhisperingBrowser({
	auth: baseEnvironment.auth,
	nodeId: createNodeId({ storage: window.localStorage }),
	defaultTranscriptionService,
	downloads: baseEnvironment.downloads,
});
