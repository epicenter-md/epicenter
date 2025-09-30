<script lang="ts">
	import { Button } from '@repo/ui/button';
	import { Badge } from '@repo/ui/badge';
	import { Progress } from '@repo/ui/progress';
	import { Download, CheckIcon, LoaderCircle, X } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import {
		exists,
		mkdir,
		writeFile,
		remove,
		stat,
	} from '@tauri-apps/plugin-fs';
	import { fetch } from '@tauri-apps/plugin-http';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { tryAsync, Ok } from 'wellcrafted/result';
	import { appDataDir, join } from '@tauri-apps/api/path';
	import { settings } from '$lib/stores/settings.svelte';
	import type {
		LocalModelConfig,
		WhisperModelConfig,
		ParakeetModelConfig,
	} from '$lib/services/transcription/local/types';

	let {
		model,
	}: {
		model: LocalModelConfig;
	} = $props();

	type ModelState =
		| { type: 'not-downloaded' }
		| { type: 'downloading'; progress: number }
		| { type: 'ready' }
		| { type: 'active' };

	let modelState = $state<ModelState>({ type: 'not-downloaded' });

	/**
	 * Calculates the destination path where this model will be downloaded and stored,
	 * and ensures that the parent directory structure exists.
	 *
	 * @returns The full path where the model should be stored:
	 * - For Whisper models: `{appDataDir}/whisper-models/{filename}` (a single file)
	 * - For Parakeet models: `{appDataDir}/parakeet-models/{directoryName}/` (a directory containing multiple files)
	 */
	async function ensureModelDestinationPath(): Promise<string> {
		const appDir = await appDataDir();

		switch (model.engine) {
			case 'whispercpp': {
				const modelsDir = await join(appDir, 'whisper-models');
				// Ensure directory exists
				if (!(await exists(modelsDir))) {
					await mkdir(modelsDir, { recursive: true });
				}
				return await join(modelsDir, model.file.filename);
			}
			case 'parakeet': {
				// Parakeet models are stored in a directory
				const parakeetModelsDir = await join(appDir, 'parakeet-models');
				// Ensure directory exists
				if (!(await exists(parakeetModelsDir))) {
					await mkdir(parakeetModelsDir, { recursive: true });
				}
				return await join(parakeetModelsDir, model.directoryName);
			}
		}
	}

	/**
	 * Validates if a model is properly installed at the given path.
	 */
	async function isModelValid(path: string): Promise<boolean> {
		switch (model.engine) {
			case 'whispercpp': {
				// For Whisper models, file existence is sufficient
				return await exists(path);
			}
			case 'parakeet': {
				if (!(await exists(path))) return false;
				// For Parakeet models, path must be a directory containing all files
				const { data: stats } = await tryAsync({
					try: () => stat(path),
					catch: () => Ok(null),
				});
				if (!stats?.isDirectory) return false;

				// Check that all required files exist
				for (const file of model.files) {
					const filePath = await join(path, file.filename);
					if (!(await exists(filePath))) return false;
				}
				return true;
			}
		}
	}

	// Check model status on mount and when settings change
	$effect(() => {
		// React to settings changes for this engine
		const settingsKey = `transcription.${model.engine}.modelPath` as const;
		const currentPath = settings.value[settingsKey];
		// Trigger refresh when settings change (currentPath is a dependency)
		refreshStatus();
	});

	async function refreshStatus() {
		await tryAsync({
			try: async () => {
				const path = await ensureModelDestinationPath();
				const isValid = await isModelValid(path);

				if (!isValid) {
					modelState = { type: 'not-downloaded' };
					return;
				}

				// Check if this model is active in settings
				const settingsKey = `transcription.${model.engine}.modelPath` as const;
				const currentPath = settings.value[settingsKey];
				const isActive = currentPath === path;

				modelState = isActive ? { type: 'active' } : { type: 'ready' };
			},
			catch: () => {
				modelState = { type: 'not-downloaded' };
				return Ok(undefined);
			},
		});
	}

	async function downloadModel() {
		if (modelState.type === 'downloading') return;

		modelState = { type: 'downloading', progress: 0 };

		await tryAsync({
			try: async () => {
				const downloadFileContent = async (
					url: string,
					sizeBytes: number,
					filePath: string,
					onProgress: (progress: number) => void,
				): Promise<void> => {
					const response = await fetch(url);
					if (!response.ok) {
						throw new Error(`Failed to download: ${response.status}`);
					}

					const contentLength = response.headers.get('content-length');
					const totalBytes = contentLength
						? Number.parseInt(contentLength, 10)
						: sizeBytes;

					const reader = response.body?.getReader();
					if (!reader) {
						throw new Error('Failed to read response body');
					}

					// Create or truncate the file first
					await writeFile(filePath, new Uint8Array());

					let downloadedBytes = 0;

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						// Write each chunk directly to disk using append mode
						await writeFile(filePath, value, { append: true });

						downloadedBytes += value.length;
						const progress = Math.round((downloadedBytes / totalBytes) * 100);
						onProgress(progress);
					}
				};

				const path = await ensureModelDestinationPath();

				// Check if already exists
				await refreshStatus();
				if (modelState.type === 'ready' || modelState.type === 'active') {
					if (modelState.type === 'ready') {
						await activateModel();
					}
					toast.success('Model already downloaded and activated');
					return;
				}

				switch (model.engine) {
					case 'whispercpp': {
						// Single file download for Whisper
						await downloadFileContent(
							model.file.url,
							model.sizeBytes,
							path,
							(progress) => {
								modelState = { type: 'downloading', progress };
							},
						);
						break;
					}
					case 'parakeet': {
						// Multiple file downloads for Parakeet
						const totalBytes = model.sizeBytes;
						let downloadedBytes = 0;

						// Create directory for model files
						await mkdir(path, { recursive: true });

						for (const file of model.files) {
							const filePath = await join(path, file.filename);
							await downloadFileContent(
								file.url,
								file.sizeBytes,
								filePath,
								(fileProgress) => {
									const overallProgress = Math.round(
										((downloadedBytes + (file.sizeBytes * fileProgress) / 100) /
											totalBytes) *
											100,
									);
									modelState = {
										type: 'downloading',
										progress: overallProgress,
									};
								},
							);
							downloadedBytes += file.sizeBytes;
						}
						break;
					}
				}

				// After download, activate the model
				await activateModel();
				modelState = { type: 'active' };
				toast.success('Model downloaded and activated successfully');
			},
			catch: (error) => {
				console.error('Download failed:', error);
				toast.error('Failed to download model', {
					description: extractErrorMessage(error),
				});
				modelState = { type: 'not-downloaded' };
				return Ok(undefined);
			},
		});
	}

	async function activateModel() {
		const path = await ensureModelDestinationPath();
		const settingsKey = `transcription.${model.engine}.modelPath` as const;

		settings.updateKey(settingsKey, path);
		// The settings watcher will update modelState to 'active'
		toast.success('Model activated');
	}

	async function deleteModel() {
		await tryAsync({
			try: async () => {
				const path = await ensureModelDestinationPath();
				if (await exists(path)) {
					await remove(path, { recursive: model.engine === 'parakeet' });
				}

				// Clear settings if this was the active model
				const settingsKey = `transcription.${model.engine}.modelPath` as const;

				if (settings.value[settingsKey] === path) {
					settings.updateKey(settingsKey, '');
				}

				modelState = { type: 'not-downloaded' };
				toast.success('Model deleted');
			},
			catch: (error) => {
				toast.error('Failed to delete model', {
					description: extractErrorMessage(error),
				});
				return Ok(undefined);
			},
		});
	}
</script>

<div
	class="flex items-center gap-3 p-3 rounded-lg border {modelState.type ===
	'active'
		? 'border-primary bg-primary/5'
		: ''}"
>
	<div class="flex-1">
		<div class="flex items-center gap-2">
			<span class="font-medium">{model.name}</span>
			{#if modelState.type === 'active'}
				<Badge variant="default" class="text-xs">Active</Badge>
			{:else if modelState.type === 'ready'}
				<Badge variant="secondary" class="text-xs">Downloaded</Badge>
			{/if}
		</div>
		<div class="text-sm text-muted-foreground">
			{model.description}
		</div>
		<div class="text-xs text-muted-foreground mt-1">
			{model.size}
		</div>
	</div>

	<div class="flex items-center gap-2">
		{#if modelState.type === 'downloading'}
			<div class="flex items-center gap-2 min-w-[120px]">
				<LoaderCircle class="size-4 animate-spin" />
				<span class="text-sm font-medium">{modelState.progress}%</span>
			</div>
		{:else if modelState.type === 'ready'}
			<Button size="sm" variant="outline" onclick={activateModel}>
				Activate
			</Button>
			<Button size="sm" variant="ghost" onclick={deleteModel}>
				<X class="size-4" />
			</Button>
		{:else if modelState.type === 'active'}
			<Button size="sm" variant="default" disabled>
				<CheckIcon class="size-4 mr-1" />
				Activated
			</Button>
			<Button size="sm" variant="ghost" onclick={deleteModel}>
				<X class="size-4" />
			</Button>
		{:else}
			<Button size="sm" variant="outline" onclick={downloadModel}>
				<Download class="size-4 mr-2" />
				Download
			</Button>
		{/if}
	</div>
</div>

{#if modelState.type === 'downloading' && modelState.progress > 0}
	<Progress value={modelState.progress} class="mt-2 h-2" />
{/if}
