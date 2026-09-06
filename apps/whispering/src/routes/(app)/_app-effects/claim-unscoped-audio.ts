import type { QueryClient } from '@tanstack/svelte-query';
import { createLogger } from 'wellcrafted/logger';
import type { WhisperingApp } from '$lib/whispering/app';

const log = createLogger('whispering/audio');

/**
 * Once per session, claim for this account the audio an earlier build wrote
 * to the origin-wide store (ADR-0349).
 *
 * The rows are the inventory, and they are all here by the time the shell
 * mounts: an open resolves after hydration, and a device that recorded under
 * the old name holds its rows in the generation it opened. Rows that arrive
 * later by sync cite bytes this device never had, so there is nothing of
 * theirs to claim.
 *
 * Fire and forget, with one consequence to carry: the recordings page runs
 * `stat` on every row concurrently with this, and caches `unavailable` for
 * anything the claim has not reached yet. A claim that moved something
 * invalidates that cache, or the person sees missing audio until a reload.
 *
 * A held store is another tab doing the same thing, and is left to it.
 */
export function claimUnscopedAudio(
	app: WhisperingApp,
	queryClient: QueryClient,
): void {
	const unscoped = app.blobs.unscoped;
	if (unscoped === null) return;
	const ids = app.recordings.sorted.map((recording) => recording.audioBlobId);
	void unscoped.claim(ids).then(({ data, error }) => {
		if (error !== null) {
			if (error.name !== 'BlobStoreHeld') log.warn(error);
			return;
		}
		if (data.claimed === 0) return;
		log.info(
			`Claimed ${data.claimed} audio file(s) an earlier version of Whispering kept unscoped.`,
		);
		// The prefix of `audioKeys.availability(...)`.
		void queryClient.invalidateQueries({ queryKey: ['audio', 'availability'] });
	});
}
