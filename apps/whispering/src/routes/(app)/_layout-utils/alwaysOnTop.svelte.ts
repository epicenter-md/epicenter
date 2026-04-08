import { createQuery } from '@tanstack/svelte-query';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { rpc } from '$lib/query';
import { settings } from '$lib/state/settings.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

export function syncWindowAlwaysOnTopWithRecorderState() {
	const getRecorderStateQuery = createQuery(() => ({
		...rpc.recorder.getRecorderState.options,
		enabled: settings.get('recording.mode') === 'manual',
	}));

	$effect(() => {
		const setAlwaysOnTop = (value: boolean) =>
			getCurrentWindow().setAlwaysOnTop(value);
		switch (settings.get('ui.alwaysOnTop')) {
			case 'Always':
				setAlwaysOnTop(true);
				break;
			case 'When Recording and Transcribing':
				if (
					getRecorderStateQuery.data === 'RECORDING' ||
					vadRecorder.state === 'SPEECH_DETECTED' ||
					rpc.transcription.isCurrentlyTranscribing()
				) {
					setAlwaysOnTop(true);
				} else {
					setAlwaysOnTop(false);
				}
				break;
			case 'When Recording':
				if (
					getRecorderStateQuery.data === 'RECORDING' ||
					vadRecorder.state === 'SPEECH_DETECTED'
				) {
					setAlwaysOnTop(true);
				} else {
					setAlwaysOnTop(false);
				}
				break;
			case 'Never':
				setAlwaysOnTop(false);
				break;
		}
	});
}
