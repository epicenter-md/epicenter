import type { ManualPlayback } from './manual-playback';

/** Browsers do not own system playback, so manual capture has no lease. */
export const manualPlayback: ManualPlayback = {
	async begin() {},
	async end() {},
};
