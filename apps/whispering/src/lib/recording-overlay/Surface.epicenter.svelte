<script lang="ts">
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import {
		recordingOverlayAction,
		recordingOverlayMicLevel,
		recordingOverlayReady,
		recordingOverlayStatus,
		revealMainWindow,
	} from './events';
	import { foldMicLevel } from '$lib/recording-pill/level';
	import type {
		RecordingPillAction,
		RecordingPillStatus,
	} from '$lib/recording-pill/model';
	import RecordingPill from '$lib/recording-pill/RecordingPill.svelte';

	let status = $state<RecordingPillStatus | null>(null);
	let level = $state(0);
	const unlisteners: UnlistenFn[] = [];
	let isDestroyed = false;

	function trackUnlistener(unlisten: UnlistenFn) {
		if (isDestroyed) unlisten();
		else unlisteners.push(unlisten);
	}

	onMount(() => {
		void (async () => {
			trackUnlistener(
				await recordingOverlayStatus.listen((event) => {
					status = event.payload;
				}),
			);
			trackUnlistener(
				await recordingOverlayMicLevel.listen((event) => {
					level = foldMicLevel(level, event.payload);
				}),
			);
			if (!isDestroyed) await recordingOverlayReady.emit();
		})();
	});

	onDestroy(() => {
		isDestroyed = true;
		for (const unlisten of unlisteners) unlisten();
	});

	function sendAction(action: RecordingPillAction) {
		void recordingOverlayAction.emit(action);
	}
</script>

<div class="fixed inset-0 flex items-center justify-center">
	<RecordingPill
		{status}
		{level}
		onStop={() => sendAction('stop')}
		onCancel={() => sendAction('cancel')}
		onShipRaw={() => sendAction('ship-raw')}
		onReveal={() => void revealMainWindow.emit()}
	/>
</div>

<style>
	:global(html),
	:global(body) {
		background: transparent !important;
		margin: 0;
		overflow: hidden;
		color-scheme: normal !important;
	}

	:global(#svelte-inspector-host) {
		display: none !important;
	}
</style>
