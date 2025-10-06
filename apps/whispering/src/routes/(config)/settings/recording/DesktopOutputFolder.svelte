<script lang="ts">
	import { Input } from '@repo/ui/input';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { FolderOpen, ExternalLink, RotateCcw } from '@lucide/svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { getDefaultRecordingsFolder } from '$lib/services/recorder';

	// Top-level await to get the default app data directory
	let defaultRecordingsFolder = $state<string | null>(null);

	// Initialize the default path asynchronously
	if (window.__TAURI_INTERNALS__) {
		getDefaultRecordingsFolder().then((path) => {
			defaultRecordingsFolder = path;
		});
	}

	// Derived state for the display path
	const displayPath = $derived(
		settings.value['recording.cpal.outputFolder'] ??
			defaultRecordingsFolder ??
			null,
	);

	async function selectOutputFolder() {
		if (!window.__TAURI_INTERNALS__) return;

		const { open } = await import('@tauri-apps/plugin-dialog');
		const selected = await open({
			directory: true,
			multiple: false,
			title: 'Select Recording Output Folder',
		});

		if (selected) settings.updateKey('recording.cpal.outputFolder', selected);
	}

	async function openOutputFolder() {
		if (!window.__TAURI_INTERNALS__) return;
		const { openPath } = await import('@tauri-apps/plugin-opener');

		const folderPath =
			settings.value['recording.cpal.outputFolder'] ?? defaultRecordingsFolder;
		if (folderPath) {
			await openPath(folderPath);
		}
	}
</script>

<div class="flex items-center gap-2">
	{#if displayPath === null}
		<Input type="text" placeholder="Loading..." disabled class="flex-1" />
	{:else}
		<Input type="text" value={displayPath} readonly class="flex-1" />
	{/if}

	<WhisperingButton
		tooltipContent="Select output folder"
		variant="outline"
		size="icon"
		onclick={selectOutputFolder}
	>
		<FolderOpen class="h-4 w-4" />
	</WhisperingButton>

	<WhisperingButton
		tooltipContent="Open output folder"
		variant="outline"
		size="icon"
		onclick={openOutputFolder}
		disabled={displayPath === null}
	>
		<ExternalLink class="h-4 w-4" />
	</WhisperingButton>

	{#if settings.value['recording.cpal.outputFolder']}
		<WhisperingButton
			tooltipContent="Reset to default folder"
			variant="outline"
			size="icon"
			onclick={() => {
				settings.updateKey('recording.cpal.outputFolder', null);
			}}
		>
			<RotateCcw class="h-4 w-4" />
		</WhisperingButton>
	{/if}
</div>
