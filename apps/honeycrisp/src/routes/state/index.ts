import type { HoneycrispWorkspace } from '@epicenter/honeycrisp';
import { createFolders } from './folders.svelte.js';
import { createNotes } from './notes.svelte.js';
import { createView } from './view.svelte.js';

export function createHoneycrispState({
	honeycrisp,
	onRecordsChanged,
}: {
	honeycrisp: HoneycrispWorkspace;
	onRecordsChanged(listener: () => void): () => void;
}) {
	let notes!: ReturnType<typeof createNotes>;
	const folders = createFolders({
		honeycrisp,
		refreshNotes: () => notes.refresh(),
	});
	notes = createNotes({ folders, honeycrisp });
	const view = createView({ folders, notes });

	const refresh = () => Promise.all([folders.refresh(), notes.refresh()]);
	const whenReady = refresh().then(() => undefined);
	const unsubscribe = onRecordsChanged(() => {
		void refresh().catch(() => undefined);
	});

	return {
		folders,
		notes,
		view,
		whenReady,
		[Symbol.dispose]() {
			unsubscribe();
			view[Symbol.dispose]();
		},
	};
}
