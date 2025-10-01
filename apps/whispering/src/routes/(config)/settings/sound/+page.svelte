<script lang="ts">
	import { LabeledSlider, LabeledSwitch } from '$lib/components/labeled';
	import { type WhisperingSoundNames } from '$lib/constants/sounds';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/stores/settings.svelte';
	import { PlayIcon, UploadIcon, XIcon } from '@lucide/svelte';
	import { Button } from '@repo/ui/button';
	import {
		ACCEPT_AUDIO,
		FileDropZone,
		MEGABYTE,
	} from '@repo/ui/file-drop-zone';
	import { Separator } from '@repo/ui/separator';

	// Sound events configuration
	const soundEvents = [
		{
			key: 'manual-start',
			label: 'Manual Recording Start',
			description: 'When you start recording manually',
		},
		{
			key: 'manual-stop',
			label: 'Manual Recording Stop',
			description: 'When you stop recording manually',
		},
		{
			key: 'manual-cancel',
			label: 'Manual Recording Cancel',
			description: 'When you cancel recording manually',
		},
		{
			key: 'cpal-start',
			label: 'CPAL Recording Start',
			description: 'When CPAL recording starts',
		},
		{
			key: 'cpal-stop',
			label: 'CPAL Recording Stop',
			description: 'When CPAL recording stops',
		},
		{
			key: 'cpal-cancel',
			label: 'CPAL Recording Cancel',
			description: 'When CPAL recording is cancelled',
		},
		{
			key: 'vad-start',
			label: 'VAD Session Start',
			description: 'When voice activity detection session begins',
		},
		{
			key: 'vad-capture',
			label: 'VAD Capture',
			description: 'When voice activity is detected and captured',
		},
		{
			key: 'vad-stop',
			label: 'VAD Session Stop',
			description: 'When voice activity detection session ends',
		},
		{
			key: 'transcriptionComplete',
			label: 'Transcription Complete',
			description: 'When audio transcription finishes',
		},
		{
			key: 'transformationComplete',
			label: 'Transformation Complete',
			description: 'When text transformation finishes',
		},
	] as const;

	const testSound = (soundKey: string) => {
		rpc.sound.playSoundIfEnabled.execute(soundKey as WhisperingSoundNames);
	};

	const applyGlobalVolume = (volume: number) => {
		const volumeDecimal = volume / 100;
		const updates: Partial<typeof settings.value> = {};

		soundEvents.forEach((event) => {
			updates[`sound.volume.${event.key}` as keyof typeof settings.value] =
				volumeDecimal as any;
		});

		settings.update(updates);
	};

	const handleCustomSoundUpload = async (
		files: File[],
		soundKey: WhisperingSoundNames,
	) => {
		console.log('🔧 Starting custom sound upload:', { files, soundKey });
		const file = files[0];
		if (!file) return;

		// Validate file
		if (!file.type.startsWith('audio/')) {
			rpc.notify.error.execute({
				title: 'Invalid file type',
				description: 'Please upload an audio file (MP3, WAV, OGG, etc.)',
			});
			return;
		}

		const maxSize = 5 * 1024 * 1024; // 5MB
		if (file.size > maxSize) {
			rpc.notify.error.execute({
				title: 'File too large',
				description: 'File size must be less than 5MB',
			});
			return;
		}

		try {
			console.log('🔧 Converting file to ArrayBuffer...');
			// Convert to persistent format (same as recordings)
			const arrayBuffer = await file.arrayBuffer();
			const now = new Date().toISOString();

			const customSound = {
				id: soundKey as any, // WhisperingSoundNames
				serializedAudio: { arrayBuffer, blobType: file.type },
				fileName: file.name,
				fileSize: file.size,
				uploadedAt: now,
				updatedAt: now,
			};

			console.log('🔧 Importing db service...');
			// Import db service dynamically to avoid circular dependencies
			const { db } = await import('$lib/services');

			console.log('🔧 Saving to IndexedDB...', customSound);
			// Save to IndexedDB
			const { error } = await db.saveCustomSound(customSound);
			if (error) {
				console.error('🔧 IndexedDB save error:', error);
				throw error;
			}

			console.log('🔧 Updating settings...');
			// Update settings flag
			settings.updateKey(`sound.custom.${soundKey}`, true);

			console.log('🔧 Custom sound upload successful!');
			// Success notification
			rpc.notify.success.execute({
				title: 'Custom sound uploaded',
				description: `Custom sound for ${soundEvents.find((e) => e.key === soundKey)?.label} has been saved.`,
			});
		} catch (error) {
			console.error('🔧 Custom sound upload failed:', error);
			rpc.notify.error.execute({
				title: 'Upload failed',
				description: 'Failed to save custom sound. Please try again.',
				action: { type: 'more-details', error },
			});
		}
	};

	const removeCustomSound = async (soundKey: WhisperingSoundNames) => {
		try {
			// Import db service dynamically to avoid circular dependencies
			const { db } = await import('$lib/services');

			// Delete from IndexedDB
			const { error } = await db.deleteCustomSound(soundKey);
			if (error) {
				throw error;
			}

			// Update settings flag
			settings.updateKey(`sound.custom.${soundKey}`, false);

			// Success notification
			rpc.notify.success.execute({
				title: 'Custom sound removed',
				description: `Reverted to default sound for ${soundEvents.find((e) => e.key === soundKey)?.label}.`,
			});
		} catch (error) {
			rpc.notify.error.execute({
				title: 'Failed to remove custom sound',
				description: 'Please try again.',
				action: { type: 'more-details', error },
			});
		}
	};

	// DEBUG: Reset database function
	const resetDatabase = async () => {
		try {
			const { db } = await import('$lib/services');
			const { error } = await db.resetDatabase();
			if (error) {
				throw error;
			}

			rpc.notify.success.execute({
				title: 'Database reset',
				description: 'Database has been reset. Please refresh the page.',
			});
		} catch (error) {
			console.error('Failed to reset database:', error);
			rpc.notify.error.execute({
				title: 'Failed to reset database',
				description: 'Please try again.',
				action: { type: 'more-details', error },
			});
		}
	};
</script>

<svelte:head>
	<title>Sound Settings - Whispering</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">Sound Settings</h3>
		<p class="text-muted-foreground text-sm">
			Configure notification sounds and volumes.
		</p>
	</div>

	<Separator />

	<!-- Global Volume Control -->
	<div class="space-y-4">
		<h4 class="text-base font-medium">Global Controls</h4>
		<div class="flex items-end gap-4">
			<LabeledSlider
				id="sound.volume.global"
				label="Set All Volumes"
				bind:value={
					() => Math.round(settings.value['sound.volume'] * 100),
					(v) => {
						settings.updateKey('sound.volume', v / 100);
						applyGlobalVolume(v);
					}
				}
				min={0}
				max={100}
				step={5}
				description="Quickly set the same volume for all notification sounds"
			/>
			<Button
				variant="outline"
				size="sm"
				onclick={() => testSound('transcriptionComplete')}
			>
				<PlayIcon class="mr-2 size-4" />
				Test
			</Button>
		</div>
	</div>

	<Separator />

	<!-- Individual Sound Controls -->
	<div class="space-y-4">
		<h4 class="text-base font-medium">Individual Sound Controls</h4>
		{#each soundEvents as event}
			<div class="border rounded-lg p-4 space-y-4">
				<div class="flex items-center justify-between">
					<div>
						<h5 class="font-medium">{event.label}</h5>
						<p class="text-sm text-muted-foreground">{event.description}</p>
					</div>
					<div class="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onclick={() => testSound(event.key)}
							disabled={!settings.value[
								`sound.playOn.${event.key}` as keyof typeof settings.value
							]}
						>
							<PlayIcon class="mr-2 size-4" />
							Test
						</Button>
						<LabeledSwitch
							id="sound.playOn.{event.key}"
							label=""
							bind:checked={
								() => settings.value[`sound.playOn.${event.key}` as keyof typeof settings.value] as boolean,
								(v) => settings.updateKey(`sound.playOn.${event.key}` as keyof typeof settings.value, v as any)
							}
						/>
					</div>
				</div>

				<LabeledSlider
					id="sound.volume.{event.key}"
					label="Volume"
					bind:value={
						() => Math.round((settings.value[`sound.volume.${event.key}` as keyof typeof settings.value] as number) * 100),
						(v) => settings.updateKey(`sound.volume.${event.key}` as keyof typeof settings.value, (v / 100) as any)
					}
					min={0}
					max={100}
					step={5}
				/>

				<!-- Custom Sound Upload Section -->
				<div class="space-y-2">
					<h6 class="text-sm font-medium">Custom Sound</h6>
					{#if settings.value[`sound.custom.${event.key}` as keyof typeof settings.value]}
						<div class="flex items-center gap-2 p-2 bg-muted rounded">
							<span class="text-sm flex-1">Custom sound uploaded</span>
							<Button
								variant="outline"
								size="sm"
								onclick={() => removeCustomSound(event.key)}
							>
								<XIcon class="mr-1 size-3" />
								Remove
							</Button>
						</div>
					{:else}
						<FileDropZone
							accept={ACCEPT_AUDIO}
							maxFiles={1}
							maxFileSize={5 * MEGABYTE}
							onUpload={(files) => handleCustomSoundUpload(files, event.key)}
							class="h-20"
						>
							<div class="flex flex-col items-center gap-1">
								<UploadIcon class="size-4 text-muted-foreground" />
								<span class="text-xs text-muted-foreground">
									Drop audio file or click to browse
								</span>
							</div>
						</FileDropZone>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<!-- DEBUG: Reset Database Button -->
	<!-- <div class="mt-8 p-4 border border-red-200 rounded-lg bg-red-50">
		<h4 class="text-sm font-medium text-red-800 mb-2">Debug: Database Reset</h4>
		<p class="text-xs text-red-600 mb-3">
			This will delete the entire database and recreate it. Use this if custom sounds aren't saving properly.
		</p>
		<Button variant="destructive" size="sm" on:click={resetDatabase}>
			Reset Database
		</Button>
	</div> -->
</div>
