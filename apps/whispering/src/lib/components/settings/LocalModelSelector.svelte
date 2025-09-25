<script lang="ts">
	import type { LocalModelConfig } from '$lib/services/transcription/local/types';
	import { FolderOpen, Paperclip, X } from '@lucide/svelte';
	import { Button } from '@repo/ui/button';
	import * as Card from '@repo/ui/card';
	import { Input } from '@repo/ui/input';
	import * as Tabs from '@repo/ui/tabs';
	import { basename } from '@tauri-apps/api/path';
	import { open } from '@tauri-apps/plugin-dialog';
	import { readDir } from '@tauri-apps/plugin-fs';
	import type { Snippet } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Ok, tryAsync } from 'wellcrafted/result';
	import LocalModelDownloadCard from './LocalModelDownloadCard.svelte';

	/**
	 * Props for the LocalModelSelector component
	 */
	type LocalModelSelectorProps = {
		/** Array of pre-built models available for download */
		models: readonly LocalModelConfig[];

		/** Component title displayed in the card header */
		title: string;

		/** Component description displayed below the title */
		description: string;

		/** Whether to select files or directories */
		fileSelectionMode: 'file' | 'directory';

		/** File extensions to filter (for file mode only) */
		fileExtensions?: string[];

		/** Bindable value with getter/setter for the model path */
		value: string;

		/** Optional footer content for pre-built models tab */
		prebuiltFooter?: Snippet;

		/** Custom instructions for manual selection tab */
		manualInstructions?: Snippet;
	};

	let {
		models,
		title,
		description,
		fileSelectionMode,
		fileExtensions = [],
		value = $bindable(),
		prebuiltFooter,
		manualInstructions,
	}: LocalModelSelectorProps = $props();

	// Extract the model name from the current path
	const modelName = $derived.by(async () => {
		const path = value;
		if (!path) return '';
		return await basename(path);
	});

	// Check if current model is pre-built
	const prebuiltModelInfo = $derived(
		models.find((m) => {
			if (!value) return false;
			switch (m.engine) {
				case 'whispercpp':
					return value.endsWith(m.file.filename);
				case 'parakeet':
					return value.endsWith(m.directoryName);
			}
		}) ?? null,
	);
	const isPrebuiltModel = $derived(!!prebuiltModelInfo);

	/**
	 * Open file/folder browser for manual model selection
	 */
	async function selectModel() {
		if (!window.__TAURI_INTERNALS__) return;

		await tryAsync({
			try: async () => {
				if (fileSelectionMode === 'directory') {
					// Directory selection for folder-based models
					const selected = await open({
						directory: true,
						multiple: false,
						title: `Select ${title} Directory`,
					});

					if (selected) {
						// Validate that it's a directory with expected files
						const entries = await readDir(selected);
						if (!entries || entries.length === 0) {
							toast.error('Selected directory appears to be empty');
							return;
						}

						value = selected;
						toast.success('Model directory selected');
					}
				} else {
					// File selection for single-file models
					const filters =
						fileExtensions.length > 0
							? [
									{
										name: `${title} Files`,
										extensions: fileExtensions,
									},
								]
							: [];

					const selected = await open({
						multiple: false,
						filters,
						title: `Select ${title} File`,
					});

					if (selected) {
						value = selected;
						toast.success('Model file selected');
					}
				}
			},
			catch: (error) => {
				toast.error('Failed to select model', {
					description: extractErrorMessage(error),
				});
				return Ok(undefined);
			},
		});
	}

	/**
	 * Clear the currently selected model
	 */
	function clearModel() {
		value = '';
		toast.success('Model path cleared');
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-lg">{title}</Card.Title>
		<Card.Description>{description}</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-6">
		<Tabs.Root value="prebuilt" class="w-full">
			<Tabs.List class="grid w-full grid-cols-2">
				<Tabs.Trigger value="prebuilt">Pre-built Models</Tabs.Trigger>
				<Tabs.Trigger value="manual">Manual Selection</Tabs.Trigger>
			</Tabs.List>

			<!-- Pre-built Models Tab -->
			<Tabs.Content value="prebuilt" class="mt-4 space-y-3">
				{#each models as model}
					<LocalModelDownloadCard {model} />
				{/each}

				{#if prebuiltFooter}
					<div class="rounded-lg border bg-muted/50 p-4">
						{@render prebuiltFooter()}
					</div>
				{/if}
			</Tabs.Content>

			<!-- Manual Selection Tab -->
			<Tabs.Content value="manual" class="mt-4 space-y-4">
				{#if manualInstructions}
					{@render manualInstructions()}
				{/if}

				<!-- Model Selection Input -->
				<div>
					<p class="text-sm font-medium mb-2">
						{#if manualInstructions}
							<span class="text-muted-foreground">Step 2:</span> Select the
							model
							{fileSelectionMode === 'directory' ? 'directory' : 'file'}
						{:else}
							Select the model
							{fileSelectionMode === 'directory' ? 'directory' : 'file'}
						{/if}
					</p>
					<div class="flex items-center gap-2">
						<Input
							type="text"
							{value}
							readonly
							placeholder="No model selected"
							class="flex-1"
						/>
						{#if value}
							<Button
								variant="outline"
								size="icon"
								onclick={clearModel}
								title="Clear model path"
							>
								<X class="size-4" />
							</Button>
						{/if}
						<Button
							variant="outline"
							size="icon"
							onclick={selectModel}
							title={fileSelectionMode === 'directory'
								? 'Browse for model directory'
								: 'Browse for model file'}
						>
							{#if fileSelectionMode === 'directory'}
								<FolderOpen class="size-4" />
							{:else}
								<Paperclip class="size-4" />
							{/if}
						</Button>
					</div>

					<!-- Display selected model info -->
					{#if value}
						<div class="mt-2 space-y-1">
							{#await modelName then name}
								{#if name}
									<p class="text-sm text-muted-foreground">
										<span class="font-medium">Selected:</span>
										{name}
									</p>
								{/if}
							{/await}

							{#if isPrebuiltModel && prebuiltModelInfo}
								<p class="text-sm text-muted-foreground">
									<span class="font-medium">Size:</span>
									{prebuiltModelInfo.size}
									{#if fileSelectionMode === 'directory'}
										(directory with model files)
									{/if}
								</p>
							{/if}
						</div>
					{/if}
				</div>
			</Tabs.Content>
		</Tabs.Root>
	</Card.Content>
</Card.Root>
