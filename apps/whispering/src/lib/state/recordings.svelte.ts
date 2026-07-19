import { createSubscriber } from 'svelte/reactivity';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '$lib/workspace';

export type { Recording } from '$lib/workspace';

export type Recordings = ReturnType<typeof createRecordings>;

/** Adds Svelte dependency tracking to the UI-free recordings namespace. */
export function createRecordings({
	recordings,
}: Pick<WhisperingApp, 'recordings'>) {
	const track = createSubscriber((update) => recordings.subscribe(update));
	return {
		get sorted() {
			track();
			return recordings.sorted;
		},
		get count() {
			track();
			return recordings.count;
		},
		get nonconforming() {
			track();
			return recordings.nonconforming;
		},
		get loadError() {
			track();
			return recordings.loadError;
		},
		// Availability follows the platform's reactive auth state, which the
		// underlying getter reads on every access; no record subscription needed.
		get remoteAvailable() {
			return recordings.remoteAvailable;
		},
		get(id: Recording['id']) {
			track();
			return recordings.get(id);
		},
		storeAudio: recordings.storeAudio,
		create: recordings.create,
		update: recordings.update,
		delete: recordings.delete,
		audioAvailability: recordings.audioAvailability,
		uploadAudio: recordings.uploadAudio,
		downloadAudio: recordings.downloadAudio,
		removeLocalAudio: recordings.removeLocalAudio,
		refresh: recordings.refresh,
		subscribe: recordings.subscribe,
	};
}
