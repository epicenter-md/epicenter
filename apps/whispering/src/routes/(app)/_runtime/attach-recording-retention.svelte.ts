import { deleteRecordings } from '$lib/operations/recordings';
import { report } from '$lib/report';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';

export function attachRecordingRetention() {
	$effect(() => {
		const strategy = settings.get('retention.strategy');
		if (strategy === 'keep-forever') return;

		const maxCount =
			strategy === 'keep-none' ? 0 : settings.get('retention.maxCount');
		const settledIds = recordings.sorted
			.filter((recording) => recording.transcription !== null)
			.map((recording) => recording.id);
		if (settledIds.length <= maxCount) return;

		const idsToDelete = settledIds.slice(maxCount);
		const rowsToDelete = recordings.sorted.filter((recording) =>
			idsToDelete.includes(recording.id),
		);
		void (async () => {
			const { error } = await deleteRecordings(rowsToDelete);
			if (error !== null) {
				report.error({
					title: 'Failed to apply recording retention',
					cause: error,
				});
			}
		})();
	});

	return () => {};
}
