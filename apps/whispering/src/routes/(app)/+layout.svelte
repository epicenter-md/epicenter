<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onDestroy, onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { analytics } from '$lib/operations/analytics';
	import { services } from '$lib/services';
	import {
		isLocalProviderId,
		PROVIDERS,
	} from '$lib/services/transcription/providers';
	import {
		cancelRecording,
		stopManualRecording,
		stopVadRecording,
	} from '$lib/operations/recording';
	import {
		RECORDING_OVERLAY_ACTION,
		RECORDING_OVERLAY_FOCUS_MAIN,
		type RecordingOverlayAction,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { localModel } from '$lib/state/local-model.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { recordingOverlay } from '#platform/recording-overlay';
	import { tauri } from '#platform/tauri';
	import { commands } from '$lib/tauri/commands';
	import AppLayout from './_components/AppLayout.svelte';
	import BottomNav from './_components/BottomNav.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';
	let { children } = $props();

	let sidebarOpen = $state(false);
	let unlistenNavigate: UnlistenFn | null = null;
	let unlistenLocalModel: UnlistenFn | null = null;
	let unlistenOverlayAction: UnlistenFn | null = null;
	let unlistenOverlayFocus: UnlistenFn | null = null;

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');

	$effect(() => {
		const unlisten = services.localShortcutManager.listen();
		return () => unlisten();
	});

	// Log app started event once on mount
	$effect(() => {
		analytics.logEvent({ type: 'app_started' });
	});

	// Single source of truth for what the overlay should show: the active
	// recorder, with manual taking precedence over VAD so the two can never
	// fight over the one overlay window if both are briefly non-idle. Both the
	// sync effect below and the action handler in onMount read this, so the
	// precedence rule lives in exactly one place. `null` when idle.
	const overlayStatus = $derived.by((): RecordingOverlayStatus | null => {
		if (manualRecorder.state === 'RECORDING')
			return { mode: 'manual', state: 'RECORDING' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return { mode: 'vad', state: vadRecorder.state };
		return null;
	});

	// Mirror the active recorder into the overlay window. On web the seam is a
	// no-op.
	$effect(() => {
		recordingOverlay.sync(overlayStatus);
	});

	// Push the ambient transcription config to Rust whenever it changes. Rust
	// owns the resident model lifecycle (cache, preload, eviction) and
	// resolves the model name against its models directory; the FE just
	// mirrors the current settings on a single channel.
	// - Drift in (engine, modelName) triggers a background preload.
	// - Other field changes (language, prompt, unloadPolicy) take effect on
	//   the next transcription with no reload.
	// Fires once on mount (per local engine) and on every subsequent change.
	$effect(() => {
		if (!tauri) return;
		const service = settings.get('transcription.service');
		if (!isLocalProviderId(service)) return;

		const modelName = deviceConfig.get(PROVIDERS[service].modelConfigKey);
		if (!modelName) return;

		const language = settings.get('transcription.language');
		const prompt = settings.get('transcription.prompt');
		void commands
			.setTranscriptionConfig({
				engine: service,
				modelName,
				language: language === 'auto' ? null : language,
				initialPrompt: prompt || null,
				unloadPolicy: deviceConfig.get('transcription.localModelUnloadPolicy'),
			})
			.catch((err) => {
				console.error('Failed to push transcription config to Rust:', err);
			});
	});

	// Listen for navigation events from other windows and subscribe to the
	// local-model lifecycle so any consumer (`localModel.isBusy`, etc.) can
	// react to load / inference / eviction events.
	onMount(async () => {
		if (!tauri) return;
		unlistenNavigate = await listen<{ path: string }>(
			'navigate-main-window',
			(event) => {
				goto(event.payload.path);
			},
		);
		// Route overlay button clicks against the live recorder state rather
		// than the overlay's payload: a click can race a state change, so we act
		// on `overlayStatus` (derived from the recorder that is actually active),
		// not on what the overlay thought it was showing.
		unlistenOverlayAction = await listen<RecordingOverlayAction>(
			RECORDING_OVERLAY_ACTION,
			(event) => {
				if (!overlayStatus) return;
				if (overlayStatus.mode === 'manual') {
					if (event.payload === 'cancel') void cancelRecording();
					else void stopManualRecording();
					return;
				}
				// VAD only supports stopping, never cancelling. Ignore a stale
				// cancel (e.g. a manual cancel that lands just as VAD starts).
				if (event.payload === 'stop') void stopVadRecording();
			},
		);
		// Clicking the overlay pill body asks the main window to come forward.
		unlistenOverlayFocus = await listen(RECORDING_OVERLAY_FOCUS_MAIN, () => {
			const mainWindow = getCurrentWindow();
			void (async () => {
				await mainWindow.show();
				await mainWindow.unminimize();
				// setFocus often rejects on macOS; the show/unminimize above is
				// what actually surfaces the window, so a failure here is fine.
				await mainWindow.setFocus().catch(() => {});
			})();
		});
		unlistenLocalModel = await localModel.attach();
	});

	onDestroy(() => {
		unlistenNavigate?.();
		unlistenLocalModel?.();
		unlistenOverlayAction?.();
		unlistenOverlayFocus?.();
	});
</script>

{#if isNarrow.current}
	<div class="flex h-full min-h-svh flex-col">
		<div class="flex-1 pb-14">
			<AppLayout> {@render children()} </AppLayout>
		</div>
		<BottomNav />
	</div>
{:else}
	<Sidebar.Provider bind:open={sidebarOpen}>
		<VerticalNav />
		<Sidebar.Inset>
			<AppLayout> {@render children()} </AppLayout>
		</Sidebar.Inset>
	</Sidebar.Provider>
{/if}
