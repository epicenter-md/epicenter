import { openDesktopEpicenter } from '@epicenter/data/desktop';
import { createLogger } from 'wellcrafted/logger';
import { BlobsLive } from '#platform/blobs';
import {
	type WhisperingAppDependencies,
	WhisperingBackgroundError,
} from './app';

const log = createLogger('whispering/epicenter-host');

/**
 * The Epicenter-hosted build's app dependencies. Pure data and
 * factories: the WebView runtime performs its honest host open handshake only
 * once `openWhisperingApp` runs inside the mounted Svelte root.
 *
 * This build opens the host-owned replica rather than one of its own, and says
 * so by naming it. Only this build is ever served by the desktop host: it is
 * selected by the `epicenter-host` resolve condition, which `build:epicenter`
 * turns on and nothing else does, so "who owns my replica" is answered by which
 * file is compiled and never has to be asked of the DOM at runtime (ADR-0190).
 */
export const whisperingPlatform: WhisperingAppDependencies = {
	openEpicenter: openDesktopEpicenter,
	blobs: BlobsLive,
	defaultTranscriptionService: 'local',
	reportBackgroundError: (cause) =>
		log.warn(WhisperingBackgroundError.AppFailed({ cause })),
};
