import { createSubscriber } from 'svelte/reactivity';
import type { WhisperingApplication } from '$lib/whispering/application';
import type { Recording } from '$lib/workspace';

export type { Recording } from '$lib/workspace';

export type Recordings = ReturnType<typeof createRecordings>;

/** Adds Svelte dependency tracking to the UI-free recordings namespace. */
export function createRecordings({
	recordings,
}: Pick<WhisperingApplication, 'recordings'>) {
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
		get(id: Recording['id']) {
			track();
			return recordings.get(id);
		},
		create: recordings.create,
		update: recordings.update,
		delete: recordings.delete,
		refresh: recordings.refresh,
		subscribe: recordings.subscribe,
	};
}
