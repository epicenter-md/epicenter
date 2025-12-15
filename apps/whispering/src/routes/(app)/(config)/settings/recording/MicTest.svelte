<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import { vadRecorder } from '$lib/query/vad.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import type { DeviceIdentifier } from '$lib/services/types';
	import { asDeviceIdentifier } from '$lib/services/types';
	import { cn } from '@epicenter/ui/utils';
	import { createQuery } from '@tanstack/svelte-query';
	import { Ok, tryAsync } from 'wellcrafted/result';
	import MicIcon from '@lucide/svelte/icons/mic';
	import MicOffIcon from '@lucide/svelte/icons/mic-off';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

	// State
	let isTestActive = $state(false);
	let selectedTestDevice = $state<DeviceIdentifier | null>(null);
	let audioLevel = $state(0);
	let errorMessage = $state<string | null>(null);
	let noAudioWarning = $state(false);

	// Audio context and analyser
	let audioContext: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let mediaStream: MediaStream | null = null;
	let animationFrameId: number | null = null;
	let noAudioTimeoutId: number | null = null;

	// Noise gate threshold to filter out background noise
	const noiseGateThreshold = 30;

	// Use VAD device enumeration since we're using browser's getUserMedia
	// (not CPAL/FFmpeg device names which won't work with Web Audio API)
	const getDevicesQuery = createQuery(vadRecorder.enumerateDevices.options);

	// Set initial device to current recording device
	$effect(() => {
		if (!selectedTestDevice && getDevicesQuery.data?.length) {
			const currentMethod = settings.value['recording.method'];
			const currentDeviceId =
				settings.value[`recording.${currentMethod}.deviceId`];
			const firstDevice = getDevicesQuery.data[0];
			selectedTestDevice =
				currentDeviceId ||
				(firstDevice ? asDeviceIdentifier(firstDevice.id) : null);
		}
	});

	const items = $derived(
		getDevicesQuery.data?.map((device) => ({
			value: device.id,
			label: device.label,
		})) ?? [],
	);

	const selectedLabel = $derived(
		items.find((item) => item.value === selectedTestDevice)?.label,
	);

	// Calculate audio levels from microphone input
	function updateAudioLevel() {
		if (!analyser || !isTestActive) return;

		const dataArray = new Uint8Array(analyser.frequencyBinCount);
		analyser.getByteFrequencyData(dataArray);

		// Calculate RMS (Root Mean Square) for more accurate level
		const sum = dataArray.reduce((acc, val) => acc + val * val, 0);
		const rms = Math.sqrt(sum / dataArray.length);

		// Apply noise gate: ignore very quiet sounds (wind, breath, background noise)
		const adjustedRms = rms < noiseGateThreshold ? 0 : rms - noiseGateThreshold;

		audioLevel = Math.min(100, Math.round(adjustedRms));

		// Check if we're getting any audio (above noise gate)
		if (audioLevel > 0) {
			noAudioWarning = false;
			if (noAudioTimeoutId) {
				clearTimeout(noAudioTimeoutId);
				noAudioTimeoutId = null;
			}
		}

		animationFrameId = requestAnimationFrame(updateAudioLevel);
	}

	async function startTest() {
		if (!selectedTestDevice) {
			errorMessage = 'Please select a device to test';
			return;
		}

		errorMessage = null;
		noAudioWarning = false;
		audioLevel = 0;

		const { error } = await tryAsync({
			try: async () => {
				// Get the raw device ID string (DeviceIdentifier is a branded type)
				// We need to extract the actual string value for getUserMedia
				const deviceId = selectedTestDevice
					? String(selectedTestDevice)
					: undefined;

				const stream = await navigator.mediaDevices.getUserMedia({
					audio: deviceId
						? {
								deviceId: { exact: deviceId },
							}
						: true,
				});

				audioContext = new AudioContext();
				analyser = audioContext.createAnalyser();
				analyser.fftSize = 256;
				analyser.smoothingTimeConstant = 0.8;

				const source = audioContext.createMediaStreamSource(stream);
				source.connect(analyser);

				mediaStream = stream;
				isTestActive = true;

				// Start animation loop
				updateAudioLevel();

				// Show warning if no audio detected after 3 seconds
				noAudioTimeoutId = window.setTimeout(() => {
					if (audioLevel === 0) {
						noAudioWarning = true;
					}
				}, 3000);

				return stream;
			},
			catch: (e) => {
				const message = e instanceof Error ? e.message : String(e);
				if (message.includes('Permission denied')) {
					errorMessage =
						'Microphone permission denied. Please allow access and try again.';
				} else if (message.includes('not found')) {
					errorMessage =
						'Device not found. Please refresh the device list and try again.';
				} else {
					errorMessage = `Failed to access microphone: ${message}`;
				}
				return Ok(undefined);
			},
		});

		if (error) {
			isTestActive = false;
		}
	}

	function stopTest() {
		// Stop animation loop
		if (animationFrameId) {
			cancelAnimationFrame(animationFrameId);
			animationFrameId = null;
		}

		// Clear timeout
		if (noAudioTimeoutId) {
			clearTimeout(noAudioTimeoutId);
			noAudioTimeoutId = null;
		}

		// Stop all tracks
		if (mediaStream) {
			mediaStream.getTracks().forEach((track) => track.stop());
			mediaStream = null;
		}

		// Close audio context
		if (audioContext) {
			audioContext.close();
			audioContext = null;
		}

		analyser = null;
		isTestActive = false;
		noAudioWarning = false;
	}

	// Cleanup on component unmount
	$effect(() => {
		return () => {
			if (isTestActive) {
				stopTest();
			}
		};
	});

	// Get color based on level
	function getLevelColor(level: number): string {
		if (level < 30) return 'bg-green-500';
		if (level < 70) return 'bg-yellow-500';
		return 'bg-red-500';
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-lg">Test Microphone</Card.Title>
		<Card.Description>
			Verify your microphone is working and check audio levels before recording
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<!-- Device Selection -->
		{#if getDevicesQuery.isPending}
			<Field.Field>
				<Field.Label for="test-device">Test Device</Field.Label>
				<Select.Root type="single" disabled>
					<Select.Trigger id="test-device" class="w-full">
						Loading devices...
					</Select.Trigger>
				</Select.Root>
			</Field.Field>
		{:else if getDevicesQuery.isError}
			<p class="text-sm text-destructive">
				{getDevicesQuery.error.title}
			</p>
		{:else}
			<Field.Field>
				<Field.Label for="test-device">Test Device</Field.Label>
				<div class="flex gap-2">
					<Select.Root
						type="single"
						disabled={isTestActive}
						bind:value={
							() => selectedTestDevice ?? asDeviceIdentifier(''),
							(value) =>
								(selectedTestDevice = value ? asDeviceIdentifier(value) : null)
						}
					>
						<Select.Trigger id="test-device" class="flex-1">
							{selectedLabel ?? 'Select a device'}
						</Select.Trigger>
						<Select.Content>
							{#each items as item}
								<Select.Item value={item.value} label={item.label} />
							{/each}
						</Select.Content>
					</Select.Root>
					<Button
						variant="outline"
						size="icon"
						disabled={isTestActive}
						onclick={() => getDevicesQuery.refetch()}
					>
						<RefreshCwIcon
							class={cn(
								'size-4',
								getDevicesQuery.isRefetching && 'animate-spin',
							)}
						/>
					</Button>
				</div>
			</Field.Field>
		{/if}

		<!-- Test Controls -->
		<div class="flex gap-2">
			{#if !isTestActive}
				<Button
					onclick={startTest}
					disabled={!selectedTestDevice}
					class="flex-1"
				>
					<MicIcon class="mr-2 size-4" />
					Start Test
				</Button>
			{:else}
				<Button onclick={stopTest} variant="destructive" class="flex-1">
					<MicOffIcon class="mr-2 size-4" />
					Stop Test
				</Button>
			{/if}
		</div>

		<!-- Audio Level Visualization -->
		{#if isTestActive}
			<div class="space-y-2">
				<div class="flex justify-between items-baseline">
					<span class="text-sm font-medium">Volume Level</span>
					<span class="text-2xl font-mono font-bold tabular-nums"
						>{audioLevel}<span class="text-sm text-muted-foreground">%</span
						></span
					>
				</div>
				<div class="h-12 w-full bg-muted rounded-lg overflow-hidden border-2">
					<div
						class={cn(
							'h-full transition-all duration-75',
							getLevelColor(audioLevel),
						)}
						style="width: {audioLevel}%"
					></div>
				</div>
			</div>
		{/if}

		<!-- Error Message -->
		{#if errorMessage}
			<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
				{errorMessage}
			</div>
		{/if}

		<!-- No Audio Warning -->
		{#if noAudioWarning && isTestActive}
			<div
				class="rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
			>
				No audio detected. Try speaking into the microphone or check your device
				settings.
			</div>
		{/if}
	</Card.Content>
</Card.Root>
