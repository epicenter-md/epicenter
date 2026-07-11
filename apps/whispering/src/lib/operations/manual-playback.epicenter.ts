import { desktop } from '#desktop';
import { log } from '$lib/report';
import { settings } from '$lib/state/settings.svelte';
import { createManualPlayback } from './manual-playback';

export const manualPlayback = createManualPlayback({
	playbackSuppression: desktop.playbackSuppression,
	isEnabled: () => settings.get('recording.suppressBackgroundAudio'),
	reportFailure: (error) => {
		log.warn(
			new Error(`Failed to suppress background audio: ${String(error)}`),
		);
	},
});
