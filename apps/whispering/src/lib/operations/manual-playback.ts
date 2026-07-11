import type { DesktopPlaybackSuppression } from '$lib/desktop/contract';
import type { PlaybackSuppressionLease } from '$lib/tauri/bindings.gen';

type ManualPlaybackDependencies = {
	playbackSuppression: DesktopPlaybackSuppression;
	isEnabled(): boolean;
	reportFailure(error: unknown): void;
};

/**
 * Own the one playback-suppression lease associated with a manual recording.
 * Recording ids scope teardown, while a generation closes a lease whose begin
 * finishes after that recording already stopped or was replaced.
 */
export function createManualPlayback({
	playbackSuppression,
	isEnabled,
	reportFailure,
}: ManualPlaybackDependencies) {
	let generation = 0;
	let desiredRecordingId: string | null = null;
	let active: {
		recordingId: string;
		lease: PlaybackSuppressionLease;
	} | null = null;

	async function close(lease: PlaybackSuppressionLease): Promise<void> {
		try {
			await playbackSuppression.end(lease);
		} catch (error) {
			reportFailure(error);
		}
	}

	return {
		async begin(recordingId: string): Promise<void> {
			const attempt = ++generation;
			desiredRecordingId = recordingId;

			const previous = active;
			active = null;
			if (previous) await close(previous.lease);
			if (!isEnabled()) return;

			let lease: PlaybackSuppressionLease;
			try {
				lease = await playbackSuppression.begin(recordingId);
			} catch (error) {
				reportFailure(error);
				return;
			}

			if (generation !== attempt || desiredRecordingId !== recordingId) {
				await close(lease);
				return;
			}
			active = { recordingId, lease };
		},

		async end(recordingId: string | null): Promise<void> {
			if (recordingId === null || desiredRecordingId !== recordingId) return;
			generation += 1;
			desiredRecordingId = null;
			const current = active;
			active = null;
			if (current?.recordingId === recordingId) await close(current.lease);
		},
	};
}

export type ManualPlayback = ReturnType<typeof createManualPlayback>;
