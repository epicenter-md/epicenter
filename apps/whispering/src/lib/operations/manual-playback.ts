/**
 * Playback suppression verbs keyed by recording id. The Epicenter host owns
 * all suppression state and every lifecycle edge (supplant, stop, cancel,
 * exit), so both calls are fire-and-forget and idempotent.
 */
export type ManualPlayback = {
	begin(recordingId: string): Promise<void>;
	end(recordingId: string | null): Promise<void>;
};
