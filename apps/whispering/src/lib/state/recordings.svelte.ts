import { createSubscriber } from 'svelte/reactivity';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '$lib/whispering/recording';

export type { Recording } from '$lib/whispering/recording';

export type Recordings = ReturnType<typeof createRecordings>;

/** Bridges committed recordings-table invalidations into Svelte tracking. */
export function createRecordings({
	recordings,
}: Pick<WhisperingApp, 'recordings'>) {
	const invalidate = createSubscriber((update) => recordings.subscribe(update));
	return {
		get sorted() {
			invalidate();
			return recordings.sorted;
		},
		get count() {
			invalidate();
			return recordings.count;
		},
		get nonconforming() {
			invalidate();
			return recordings.nonconforming;
		},
		get loadError() {
			invalidate();
			return recordings.loadError;
		},
		// Availability follows the platform's reactive auth state, which the
		// underlying getter reads on every access; no record subscription needed.
		get remoteAvailable() {
			return recordings.remoteAvailable;
		},
		get(id: Recording['id']) {
			invalidate();
			return recordings.get(id);
		},
		storeAudio: recordings.storeAudio,
		create: recordings.create,
		patch: recordings.patch,
		delete: recordings.delete,
		audioAvailability: recordings.audioAvailability,
		uploadAudio: recordings.uploadAudio,
		downloadAudio: recordings.downloadAudio,
		removeLocalAudio: recordings.removeLocalAudio,
		subscribe: recordings.subscribe,
	};
}
