import { desktop } from '#desktop';
import { log } from '$lib/report';
import { settings } from '$lib/state/settings.svelte';
import type { ManualPlayback } from './manual-playback';

export const manualPlayback: ManualPlayback = {
	async begin(recordingId) {
		const mode = settings.get('recording.playbackSuppression');
		if (mode === 'off') return;
		try {
			await desktop.playbackSuppression.begin(recordingId, mode);
		} catch (error) {
			log.warn(
				new Error(`Failed to suppress other apps' audio: ${String(error)}`),
			);
		}
	},
	async end(recordingId) {
		if (recordingId === null) return;
		try {
			await desktop.playbackSuppression.end(recordingId);
		} catch (error) {
			log.warn(
				new Error(`Failed to restore other apps' audio: ${String(error)}`),
			);
		}
	},
};
