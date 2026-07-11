import type { ManualPlayback } from './manual-playback';

/** Browsers cannot touch other apps' audio, so both verbs are no-ops. */
export const manualPlayback: ManualPlayback = {
	async begin() {},
	async end() {},
};
