import { openDesktopEpicenter } from '@epicenter/data/legacy/desktop';
import { BlobsLive } from '#platform/blobs';
import { log } from '$lib/report';
import type { WhisperingAppDependencies } from './app';

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
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering app background failure',
		),
};
