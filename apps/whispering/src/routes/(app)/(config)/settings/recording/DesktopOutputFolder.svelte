<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { PATHS } from '$lib/constants/paths';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/stores/settings.svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { Input } from '@epicenter/ui/input';
	import { Ok, tryAsync } from 'wellcrafted/result';

	// Top-level await to get the default app data directory
	let defaultRecordingsFolder = $state<string | null>(null);

	// Initialize the default path asynchronously
	if (window.__TAURI_INTERNALS__) {
		PATHS.DB.RECORDINGS().then((path) => {
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

		await tryAsync({
			try: async () => {
				const { openPath } = await import('@tauri-apps/plugin-opener');

				const folderPath =
					settings.value['recording.cpal.outputFolder'] ??
					defaultRecordingsFolder;
				if (!folderPath) {
					throw new Error('No output folder configured');
				}
				await openPath(folderPath);
			},
			catch: (error) => {
				let description = 'Unknown error';
				if (typeof error === 'string') {
					description = error;
				} else if (error instanceof Error) {
					description = error.message;
				}

				rpc.notify.error.execute({
					title: 'Failed to open folder',
					description,
				});
				return Ok(undefined);
			},
		});
	}
</script>

<div class="flex items-center gap-2">
	{#if displayPath === null}
		<Input type="text" placeholder="Loading..." disabled class="flex-1" />
	{:else}
		<Input type="text" value={displayPath} readonly class="flex-1" />
	{/if}

	<Button
		tooltip="Select output folder"
		variant="outline"
		size="icon"
		onclick={selectOutputFolder}
	>
		<FolderOpen class="h-4 w-4" />
	</Button>

	<Button
		tooltip="Open output folder"
		variant="outline"
		size="icon"
		onclick={openOutputFolder}
		disabled={displayPath === null}
	>
		<ExternalLink class="h-4 w-4" />
	</Button>

	{#if settings.value['recording.cpal.outputFolder']}
		<Button
			tooltip="Reset to default folder"
			variant="outline"
			size="icon"
			onclick={() => {
				settings.updateKey('recording.cpal.outputFolder', null);
			}}
		>
			<RotateCcw class="h-4 w-4" />
		</Button>
	{/if}
</div>
