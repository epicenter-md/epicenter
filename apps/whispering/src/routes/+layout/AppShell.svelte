<script lang="ts">
	import { goto } from '$app/navigation';
	import { commandCallbacks } from '$lib/commands';
	import ConfirmationDialog from '$lib/components/ConfirmationDialog.svelte';
	import MoreDetailsDialog from '$lib/components/MoreDetailsDialog.svelte';
	import NotificationLog from '$lib/components/NotificationLog.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';
	import { rpc } from '$lib/query';
	import * as services from '$lib/services';
	import { settings } from '$lib/stores/settings.svelte';
	// import { extension } from '@repo/extension';
	import { createQuery } from '@tanstack/svelte-query';
	import { ModeWatcher, mode } from 'mode-watcher';
	import { onDestroy, onMount } from 'svelte';
	import { Toaster, type ToasterProps } from 'svelte-sonner';
	import { syncWindowAlwaysOnTopWithRecorderState } from './alwaysOnTop.svelte';
	import { checkForUpdates } from './check-for-updates';
	import {
		resetGlobalShortcutsToDefaultIfDuplicates,
		resetLocalShortcutsToDefaultIfDuplicates,
		syncGlobalShortcutsWithSettings,
		syncLocalShortcutsWithSettings,
	} from './register-commands';
	import { registerOnboarding } from './register-onboarding';
	import {
		checkFfmpegRecordingMethodCompatibility,
		checkLocalTranscriptionCompatibility,
		checkCompressionRecommendation,
	} from './check-ffmpeg';
	import {
		registerAccessibilityPermission,
		registerMicrophonePermission,
	} from './register-permissions';
	import { syncIconWithRecorderState } from './syncIconWithRecorderState.svelte';

	const getRecorderStateQuery = createQuery(
		rpc.recorder.getRecorderState.options,
	);
	const getVadStateQuery = createQuery(rpc.vadRecorder.getVadState.options);

	let cleanupAccessibilityPermission: (() => void) | undefined;
	let cleanupMicrophonePermission: (() => void) | undefined;

	onMount(async () => {
		window.commands = commandCallbacks;
		window.goto = goto;
		syncLocalShortcutsWithSettings();
		resetLocalShortcutsToDefaultIfDuplicates();
		await checkFfmpegRecordingMethodCompatibility();
		await checkLocalTranscriptionCompatibility();
		await checkCompressionRecommendation();
		if (window.__TAURI_INTERNALS__) {
			syncGlobalShortcutsWithSettings();
			resetGlobalShortcutsToDefaultIfDuplicates();
			await checkForUpdates();
		} else {
			// const _notifyWhisperingTabReadyResult =
			// await extension.notifyWhisperingTabReady(undefined);
		}
		registerOnboarding();

		// Register permission checkers separately
		cleanupAccessibilityPermission = registerAccessibilityPermission();
		cleanupMicrophonePermission = registerMicrophonePermission();
	});

	onDestroy(() => {
		cleanupAccessibilityPermission?.();
		cleanupMicrophonePermission?.();
	});

	if (window.__TAURI_INTERNALS__) {
		syncWindowAlwaysOnTopWithRecorderState();
		syncIconWithRecorderState();
	}

	$effect(() => {
		getRecorderStateQuery.data;
		getVadStateQuery.data;
		services.db.cleanupExpiredRecordings({
			recordingRetentionStrategy:
				settings.value['database.recordingRetentionStrategy'],
			maxRecordingCount: settings.value['database.maxRecordingCount'],
		});
	});

	const TOASTER_SETTINGS = {
		position: 'bottom-right',
		richColors: true,
		duration: 5000,
		visibleToasts: 5,
		toastOptions: {
			classes: {
				toast: 'flex flex-wrap *:data-content:flex-1',
				icon: 'shrink-0',
				actionButton: 'w-full mt-3 inline-flex justify-center',
				closeButton: 'w-full mt-3 inline-flex justify-center',
			},
		},
		closeButton: true,
	} satisfies ToasterProps;

	let { children } = $props();
</script>

<button
	class="xxs:hidden hover:bg-accent hover:text-accent-foreground h-screen w-screen transform duration-300 ease-in-out"
	onclick={commandCallbacks.toggleManualRecording}
>
	<span
		style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5));"
		class="text-[48px] leading-none"
	>
		{#if getRecorderStateQuery.data === 'RECORDING'}
			⏹️
		{:else}
			🎙️
		{/if}
	</span>
</button>

<div class="hidden flex-col items-center gap-2 xxs:flex min-w-0">
	{@render children()}
</div>

<Toaster
	offset={16}
	class="xs:block hidden"
	theme={mode.current}
	{...TOASTER_SETTINGS}
/>
<ModeWatcher />
<ConfirmationDialog />
<MoreDetailsDialog />
<NotificationLog />
<UpdateDialog />

<style>
	:global(body) {
		min-height: 100vh;
		display: grid;
		grid-template-rows: 1fr auto;
	}
</style>
