<script lang="ts">
	import { PATHS } from '$lib/constants/paths';
	import {
		isModelFileSizeValid,
		type LocalModelConfig,
	} from '$lib/services/isomorphic/transcription/local/types';
	import { settings } from '$lib/stores/settings.svelte';
	import { downloadFileOptimized, formatSpeed } from '$lib/utils/parallel-download';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import { Spinner } from '@epicenter/ui/spinner';
	import X from '@lucide/svelte/icons/x';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Progress } from '@epicenter/ui/progress';
	import { join } from '@tauri-apps/api/path';
	import {
		exists,
		mkdir,
		remove,
		stat,
	} from '@tauri-apps/plugin-fs';
	import { toast } from 'svelte-sonner';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Ok, tryAsync } from 'wellcrafted/result';

	let {
		model,
	}: {
		model: LocalModelConfig;
	} = $props();

	type ModelState =
		| { type: 'not-downloaded' }
		| { type: 'downloading'; progress: number; speed?: number }
		| { type: 'ready' }
		| { type: 'active' };

	let modelState = $state<ModelState>({ type: 'not-downloaded' });

	/**
	 * Calculates the destination path where this model will be downloaded and stored,
	 * and ensures that the parent directory structure exists.
	 *
	 * @returns The full path where the model should be stored:
	 * - For Whisper models: `{appDataDir}/models/whisper/{filename}` (a single file)
	 * - For Parakeet models: `{appDataDir}/models/parakeet/{directoryName}/` (a directory containing multiple files)
	 * - For Moonshine models: `{appDataDir}/models/moonshine/{directoryName}/` (a directory containing multiple files)
	 */
	async function ensureModelDestinationPath(): Promise<string> {
		switch (model.engine) {
			case 'whispercpp': {
				const modelsDir = await PATHS.MODELS.WHISPER();
				// Ensure directory exists
				if (!(await exists(modelsDir))) {
					await mkdir(modelsDir, { recursive: true });
				}
				return await join(modelsDir, model.file.filename);
			}
			case 'parakeet': {
				// Parakeet models are stored in a directory
				const parakeetModelsDir = await PATHS.MODELS.PARAKEET();
				// Ensure directory exists
				if (!(await exists(parakeetModelsDir))) {
					await mkdir(parakeetModelsDir, { recursive: true });
				}
				return await join(parakeetModelsDir, model.directoryName);
			}
			case 'moonshine': {
				// Moonshine models are stored in a directory
				const moonshineModelsDir = await PATHS.MODELS.MOONSHINE();
				// Ensure directory exists
				if (!(await exists(moonshineModelsDir))) {
					await mkdir(moonshineModelsDir, { recursive: true });
				}
				return await join(moonshineModelsDir, model.directoryName);
			}
			case 'canary': {
				// Canary models are stored in a directory (multi-file ONNX model)
				const canaryModelsDir = await PATHS.MODELS.CANARY();
				// Ensure directory exists
				if (!(await exists(canaryModelsDir))) {
					await mkdir(canaryModelsDir, { recursive: true });
				}
				return await join(canaryModelsDir, model.directoryName);
			}
		}
	}

	/**
	 * Validates if a model is properly installed at the given path.
	 */
	async function isModelValid(path: string): Promise<boolean> {
		switch (model.engine) {
			case 'whispercpp': {
				if (!(await exists(path))) return false;
				// Check file size to detect corrupted/incomplete downloads
				const { data: stats } = await tryAsync({
					try: () => stat(path),
					catch: () => Ok(null),
				});
				if (!stats) return false;
				if (!isModelFileSizeValid(stats.size, model.sizeBytes)) {
					console.warn(
						`Model file appears corrupted: ${Math.round(stats.size / 1_000_000)}MB, expected ~${Math.round(model.sizeBytes / 1_000_000)}MB`,
					);
					return false;
				}
				return true;
			}
			case 'parakeet':
			case 'moonshine':
			case 'canary': {
				if (!(await exists(path))) return false;
				// For multi-file models, path must be a directory containing all files
				const { data: dirStats } = await tryAsync({
					try: () => stat(path),
					catch: () => Ok(null),
				});
				if (!dirStats?.isDirectory) return false;

				// Check that all required files exist and have valid sizes
				for (const file of model.files) {
					const filePath = await join(path, file.filename);
					if (!(await exists(filePath))) return false;
					// Check file size to detect corrupted/incomplete downloads
					const { data: fileStats } = await tryAsync({
						try: () => stat(filePath),
						catch: () => Ok(null),
					});
					if (!fileStats) return false;
					if (!isModelFileSizeValid(fileStats.size, file.sizeBytes)) {
						console.warn(
							`${model.engine} file "${file.filename}" appears corrupted: ${Math.round(fileStats.size / 1_000_000)}MB, expected ~${Math.round(file.sizeBytes / 1_000_000)}MB`,
						);
						return false;
					}
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
						// Single file download for Whisper - use optimized parallel download
						await downloadFileOptimized(
							model.file.url,
							path,
							model.sizeBytes,
							(progress, speed) => {
								modelState = { type: 'downloading', progress, speed };
							},
						);
						break;
					}
					case 'parakeet':
					case 'moonshine':
					case 'canary': {
						// Multiple file downloads for multi-file models
						const totalBytes = model.sizeBytes;
						let downloadedBytes = 0;

						// Create directory for model files
						await mkdir(path, { recursive: true });

						// Download files - large files get parallel download automatically
						for (const file of model.files) {
							const filePath = await join(path, file.filename);
							const fileStartBytes = downloadedBytes;

							await downloadFileOptimized(
								file.url,
								filePath,
								file.sizeBytes,
								(fileProgress, speed) => {
									const overallProgress = Math.round(
										((fileStartBytes + (file.sizeBytes * fileProgress) / 100) /
											totalBytes) *
											100,
									);
									modelState = {
										type: 'downloading',
										progress: overallProgress,
										speed,
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
					const isDirectory =
						model.engine === 'parakeet' || model.engine === 'moonshine' || model.engine === 'canary';
					await remove(path, { recursive: isDirectory });
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
			<div class="flex items-center gap-2 min-w-[160px]">
				<Spinner />
				<div class="flex flex-col items-end">
					<span class="text-sm font-medium">{modelState.progress}%</span>
					{#if modelState.speed}
						<span class="text-xs text-muted-foreground">{formatSpeed(modelState.speed)}</span>
					{/if}
				</div>
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
				<Download class="size-4" />
				Download
			</Button>
		{/if}
	</div>
</div>

{#if modelState.type === 'downloading' && modelState.progress > 0}
	<Progress value={modelState.progress} class="mt-2 h-2" />
{/if}
