<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Dialog from '@epicenter/ui/dialog';
	// import { extension } from '@epicenter/extension';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { commandCallbacks } from '$lib/commands';
	import MoreDetailsDialog from '$lib/components/MoreDetailsDialog.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';
	import {
		RECORDER_STATE_TO_ICON,
		VAD_STATE_TO_ICON,
	} from '$lib/constants/audio';
	import { migrationDialog } from '$lib/migration/migration-dialog.svelte';
	import { services } from '$lib/services';
	import { tauri } from '$lib/tauri';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { syncWindowAlwaysOnTopWithRecorderState } from '../_layout-utils/alwaysOnTop.svelte';
	import { checkForUpdates } from '../_layout-utils/check-for-updates';
	import {
		resetGlobalShortcutsToDefaultIfDuplicates,
		resetLocalShortcutsToDefaultIfDuplicates,
		syncGlobalShortcutsWithSettings,
		syncLocalShortcutsWithSettings,
	} from '../_layout-utils/register-commands';
	import { registerOnboarding } from '../_layout-utils/register-onboarding';
	import { registerAccessibilityPermission } from '../_layout-utils/register-accessibility-permission';
	import { syncIconWithRecorderState } from '../_layout-utils/syncIconWithRecorderState.svelte';

	let cleanupAccessibilityPermission: (() => void) | undefined;

	onMount(() => {
		// Sync operations - run immediately, these are fast
		window.commands = commandCallbacks;
		window.goto = goto;
		syncLocalShortcutsWithSettings();
		resetLocalShortcutsToDefaultIfDuplicates();
		registerOnboarding();
		cleanupAccessibilityPermission = registerAccessibilityPermission();

		// Platform-agnostic async checks
		migrationDialog.check();

		if (tauri) {
			syncGlobalShortcutsWithSettings();
			resetGlobalShortcutsToDefaultIfDuplicates();

			// Desktop-only async check - fire and forget
			void checkForUpdates();
		} else {
			// Browser extension context - notify that the Whispering tab is ready
			// extension.notifyWhisperingTabReady(undefined);
		}
	});

	onDestroy(() => {
		cleanupAccessibilityPermission?.();
	});

	if (tauri) {
		syncWindowAlwaysOnTopWithRecorderState(tauri);
		syncIconWithRecorderState(tauri);
	}

	$effect(() => {
		const strategy = settings.get('retention.strategy');
		if (strategy !== 'limit-count') return;

		const maxCount = settings.get('retention.maxCount');
		const allRecordingIds = recordings.sorted.map((r) => r.id);
		if (allRecordingIds.length <= maxCount) return;

		const idsToDelete = allRecordingIds.slice(maxCount);
		// Delete audio blobs from storage
		services.blobs.audio.delete(idsToDelete);
		// Delete recording metadata from workspace (single-scan bulk)
		recordings.bulkDelete(idsToDelete);
	});

	let { children } = $props();
</script>

{#if settings.get('recording.mode') === 'vad'}
	<button
		class="xxs:hidden hover:bg-accent hover:text-accent-foreground h-screen w-screen transform duration-300 ease-in-out"
		onclick={() => commandCallbacks.toggleVadRecording()}
	>
		<span
			style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5));"
			class="text-[48px] leading-none"
		>
			{VAD_STATE_TO_ICON[vadRecorder.state]}
		</span>
	</button>
{:else}
	<button
		class="xxs:hidden hover:bg-accent hover:text-accent-foreground h-screen w-screen transform duration-300 ease-in-out"
		onclick={() => commandCallbacks.toggleManualRecording()}
	>
		<span
			style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5));"
			class="text-[48px] leading-none"
		>
			{RECORDER_STATE_TO_ICON[manualRecorder.state]}
		</span>
	</button>
{/if}

<div class="hidden flex-1 flex-col gap-2 xxs:flex min-w-0 w-full">
	{@render children()}
</div>

<ConfirmationDialog />
<MoreDetailsDialog />
<UpdateDialog />
