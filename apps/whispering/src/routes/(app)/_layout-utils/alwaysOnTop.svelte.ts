import { createQuery } from '@tanstack/svelte-query';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { rpc } from '$lib/query';
import { settings } from '$lib/stores/settings.svelte';

export function syncWindowAlwaysOnTopWithRecorderState() {
	const getRecorderStateQuery = createQuery(() => ({
		...rpc.recorder.getRecorderState.options(),
		enabled: settings.value['recording.mode'] === 'manual',
	}));

	const getVadStateQuery = createQuery(() => ({
		...rpc.vadRecorder.getVadState.options(),
		enabled: settings.value['recording.mode'] === 'vad',
	}));

	$effect(() => {
		const setAlwaysOnTop = (value: boolean) =>
			getCurrentWindow().setAlwaysOnTop(value);
		switch (settings.value['system.alwaysOnTop']) {
			case 'Always':
				setAlwaysOnTop(true);
				break;
			case 'When Recording and Transcribing':
				if (
					getRecorderStateQuery.data === 'RECORDING' ||
					getVadStateQuery.data === 'SPEECH_DETECTED' ||
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
					getVadStateQuery.data === 'SPEECH_DETECTED'
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
