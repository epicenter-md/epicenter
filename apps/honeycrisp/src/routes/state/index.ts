import type { HoneycrispWorkspace } from '@epicenter/honeycrisp';
import { createFolders } from './folders.svelte.js';
import { createNotes } from './notes.svelte.js';
import { createView } from './view.svelte.js';

export function createHoneycrispState({
	honeycrisp,
	onRecordsChanged,
	reportBackgroundError,
}: {
	honeycrisp: HoneycrispWorkspace;
	onRecordsChanged(listener: () => void): () => void;
	reportBackgroundError(cause: unknown): void;
}) {
	let notes!: ReturnType<typeof createNotes>;
	const folders = createFolders({
		honeycrisp,
		refreshNotes: () => notes.refresh(),
	});
	notes = createNotes({ folders, honeycrisp });
	const view = createView({ folders, notes });

	const refresh = () => Promise.all([folders.refresh(), notes.refresh()]);
	let isDisposed = false;
	let unsubscribe = () => {};
	const whenReady = refresh().then(() => {
		if (isDisposed) return;
		unsubscribe = onRecordsChanged(() => {
			void refresh().catch(reportBackgroundError);
		});
	});

	return {
		folders,
		notes,
		view,
		whenReady,
		[Symbol.dispose]() {
			isDisposed = true;
			unsubscribe();
			view[Symbol.dispose]();
		},
	};
}
