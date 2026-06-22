<script lang="ts">
	import { type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { revealMainWindow } from '$lib/main-window';
	import {
		recordingOverlayAction,
		recordingOverlayMicLevel,
		recordingOverlayReady,
		recordingOverlayStatus,
		type RecordingOverlayAction,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';
	import { foldMicLevel } from '$lib/recording-overlay/level';
	import RecordingPill from '$lib/recording-overlay/RecordingPill.svelte';

	// Tauri adapter for the recording pill. The overlay lives in its own webview,
	// so it cannot read the recorder state modules directly: the main window
	// pushes the current status over a Tauri event and we render from that, and
	// control gestures go back over Tauri events. The pill itself
	// (`RecordingPill`) is platform-free; this route owns the IPC glue.
	let status = $state<RecordingOverlayStatus | null>(null);

	// Live, smoothed mic loudness, 0 (silent) to 1 (loud). Driven by the
	// `mic-level` event: VAD frames in JS for voice-activated capture, the Rust
	// CPAL worker for manual recording. Both send a raw RMS amplitude; we apply
	// the perceptual curve and smoothing (shared with the web pill) so the bars
	// react to the actual voice rather than looping on a timer.
	let level = $state(0);

	const unlisteners: UnlistenFn[] = [];

	onMount(async () => {
		unlisteners.push(
			await recordingOverlayStatus.listen((event) => {
				status = event.payload;
			}),
			await recordingOverlayMicLevel.listen((event) => {
				level = foldMicLevel(level, event.payload);
			}),
		);
		// Tell the main window we are ready so it re-sends the latest status.
		// Without this handshake the status emitted right after window creation
		// can land before our listener is attached.
		await recordingOverlayReady.emit();
	});

	onDestroy(() => {
		for (const unlisten of unlisteners) unlisten();
	});

	function sendAction(action: RecordingOverlayAction) {
		void recordingOverlayAction.emit(action);
	}

	function focusMainWindow() {
		// Clicking the pill body raises the main window (the shared reveal).
		void revealMainWindow.emit({});
	}
</script>

<!-- The pill hugs its content, so center it within the fixed overlay window (the
     web host centers its own copy). A fixed full-window flex box centers the chip
     regardless of how the layout nests the route. -->
<div class="fixed inset-0 flex items-center justify-center">
	<RecordingPill
		{status}
		{level}
		onStop={() => sendAction('stop')}
		onCancel={() => sendAction('cancel')}
		onShipRaw={() => sendAction('ship-raw')}
		onReveal={focusMainWindow}
	/>
</div>

<style>
	/* The document-level resets below stay as `:global` CSS: a component cannot
	   apply utilities to `html`/`body` or to the dev-injected inspector host, so
	   these have no Tailwind equivalent. They belong to the overlay webview, not the
	   pill: they are only ever loaded in the dedicated overlay Tauri window, which
	   has its own document. The main app window never navigates here, so its
	   document background is untouched. (The isolation comes from the separate
	   webview document, not from Svelte's component scoping.) The shared
	   `RecordingPill` keeps no document-level styles so it can also mount inside the
	   app on web. */
	:global(html),
	:global(body) {
		background: transparent !important;
		margin: 0;
		overflow: hidden;
		/* The app shell forces a dark theme (ModeWatcher sets color-scheme:dark),
		   which makes the browser paint a dark canvas behind the pill in this
		   transparent webview. Reset it so only the pill is visible. */
		color-scheme: normal !important;
	}

	/* The Svelte inspector toggle (svelte.config.js `showToggleButton: always`)
	   is injected into every dev document, including this overlay webview where
	   it overlaps the pill. Hide it here; this rule lives only in the overlay
	   webview's document, and the host element does not exist in production. */
	:global(#svelte-inspector-host) {
		display: none !important;
	}
</style>
