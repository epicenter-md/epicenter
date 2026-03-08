<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import { Switch } from '@epicenter/ui/switch';
	import PlayIcon from '@lucide/svelte/icons/play';
	import type { WhisperingSoundNames } from '$lib/constants/sounds';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/state/settings.svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { createMutation } from '@tanstack/svelte-query';

	const availableSoundsQuery = createQuery(() => rpc.sound.listAvailableSounds.options);
	const previewMutation = createMutation(() => rpc.sound.previewSound.options);

	const availableSounds = $derived(
		availableSoundsQuery.data?.data ?? [],
	);

	const eventLabels: Record<WhisperingSoundNames, string> = {
		'manual-start': 'Play sound when starting manual recording',
		'manual-stop': 'Play sound when stopping manual recording',
		'manual-cancel': 'Play sound when canceling manual recording',
		'vad-start': 'Play sound when starting VAD recording session',
		'vad-capture': 'Play sound on VAD capture',
		'vad-stop': 'Play sound when stopping VAD recording session',
		transcriptionComplete: 'Play sound after transcription',
		transformationComplete: 'Play sound after transformation',
	};

	type WorkspaceSettingKey = Parameters<typeof settings.get>[0];

	const soundToggleKeyMap = {
		'manual-start': 'sound.manualStart',
		'manual-stop': 'sound.manualStop',
		'manual-cancel': 'sound.manualCancel',
		'vad-start': 'sound.vadStart',
		'vad-capture': 'sound.vadCapture',
		'vad-stop': 'sound.vadStop',
		transcriptionComplete: 'sound.transcriptionComplete',
		transformationComplete: 'sound.transformationComplete',
	} as const satisfies Record<WhisperingSoundNames, WorkspaceSettingKey>;

	function soundsForEvent(eventName: WhisperingSoundNames) {
		return availableSounds.filter((s) => s.eventTypes.includes(eventName));
	}

	function selectedSoundLabel(eventName: WhisperingSoundNames): string {
		const key = `sound.selectedSound.${eventName}` as any;
		const selectedId = settings.get(key) as string;
		const sounds = soundsForEvent(eventName);
		const found = sounds.find((s) => s.id === selectedId);
		return found?.name ?? selectedId ?? 'Default';
	}

	function updateSelectedSound(
		eventName: WhisperingSoundNames,
		soundId: string,
	) {
		const key = `sound.selectedSound.${eventName}` as any;
		settings.set(key, soundId);
	}

	function previewSound(soundId: string) {
		previewMutation.mutate(soundId);
	}
</script>

<svelte:head> <title>Sound Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Sound</Field.Legend>
	<Field.Description>
		Configure your Whispering sound preferences. Choose which sounds to play
		at each step and pick from bundled or system sounds (desktop only).
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Manual Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for manual recording events.
			</Field.Description>
			<Field.Group>
				{#each ['manual-start', 'manual-stop', 'manual-cancel'] as eventName}
					{@const sounds = soundsForEvent(eventName as WhisperingSoundNames)}
					<Field.Field orientation="horizontal" class="flex-wrap items-center gap-x-2 gap-y-2">
						<Switch
							id="sound.playOn.{eventName}"
							bind:checked={() => settings.get(soundToggleKeyMap[eventName as WhisperingSoundNames]),
								(v) => settings.set(soundToggleKeyMap[eventName as WhisperingSoundNames], v)}
						/>
						<Field.Label for="sound.playOn.{eventName}" class="flex-1 min-w-0">
							{eventLabels[eventName as WhisperingSoundNames]}
						</Field.Label>
						{#if availableSoundsQuery.isSuccess && sounds.length > 0}
							<div class="flex items-center gap-1 shrink-0">
								<Select.Root
									type="single"
									bind:value={() => settings.get(`sound.selectedSound.${eventName}` as any) as string,
										(v) => v != null && updateSelectedSound(eventName as WhisperingSoundNames, v)}
								>
									<Select.Trigger id="sound-select-{eventName}" class="w-40">
										{selectedSoundLabel(eventName as WhisperingSoundNames)}
									</Select.Trigger>
									<Select.Content>
										{#each sounds as sound (sound.id)}
											<Select.Item
												value={sound.id}
												label={sound.source === 'os' ? `${sound.name} (system)` : sound.name}
											>
												{sound.name}
												{#if sound.source === 'os'}
													<span class="text-muted-foreground text-xs"> (system)</span>
												{/if}
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
								<Button
									variant="ghost"
									size="icon"
									class="shrink-0"
									onclick={() => previewSound(settings.get(`sound.selectedSound.${eventName}` as any) as string)}
									disabled={previewMutation.isPending}
									tooltip="Preview sound"
								>
									<PlayIcon class="size-4" />
								</Button>
							</div>
						{/if}
					</Field.Field>
				{/each}
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">VAD Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for voice-activated detection events.
			</Field.Description>
			<Field.Group>
				{#each ['vad-start', 'vad-capture', 'vad-stop'] as eventName}
					{@const sounds = soundsForEvent(eventName as WhisperingSoundNames)}
					<Field.Field orientation="horizontal" class="flex-wrap items-center gap-x-2 gap-y-2">
						<Switch
							id="sound.playOn.{eventName}"
							bind:checked={() => settings.get(soundToggleKeyMap[eventName as WhisperingSoundNames]),
								(v) => settings.set(soundToggleKeyMap[eventName as WhisperingSoundNames], v)}
						/>
						<Field.Label for="sound.playOn.{eventName}" class="flex-1 min-w-0">
							{eventLabels[eventName as WhisperingSoundNames]}
						</Field.Label>
						{#if availableSoundsQuery.isSuccess && sounds.length > 0}
							<div class="flex items-center gap-1 shrink-0">
								<Select.Root
									type="single"
									bind:value={() => settings.get(`sound.selectedSound.${eventName}` as any) as string,
										(v) => v != null && updateSelectedSound(eventName as WhisperingSoundNames, v)}
								>
									<Select.Trigger id="sound-select-{eventName}" class="w-40">
										{selectedSoundLabel(eventName as WhisperingSoundNames)}
									</Select.Trigger>
									<Select.Content>
										{#each sounds as sound (sound.id)}
											<Select.Item
												value={sound.id}
												label={sound.source === 'os' ? `${sound.name} (system)` : sound.name}
											>
												{sound.name}
												{#if sound.source === 'os'}
													<span class="text-muted-foreground text-xs"> (system)</span>
												{/if}
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
								<Button
									variant="ghost"
									size="icon"
									class="shrink-0"
									onclick={() => previewSound(settings.get(`sound.selectedSound.${eventName}` as any) as string)}
									disabled={previewMutation.isPending}
									tooltip="Preview sound"
								>
									<PlayIcon class="size-4" />
								</Button>
							</div>
						{/if}
					</Field.Field>
				{/each}
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Completion Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for transcription and transformation completion.
			</Field.Description>
			<Field.Group>
				{#each ['transcriptionComplete', 'transformationComplete'] as eventName}
					{@const sounds = soundsForEvent(eventName as WhisperingSoundNames)}
					<Field.Field orientation="horizontal" class="flex-wrap items-center gap-x-2 gap-y-2">
						<Switch
							id="play-sound-{eventName}"
							bind:checked={() => settings.get(soundToggleKeyMap[eventName as WhisperingSoundNames]),
								(v) => settings.set(soundToggleKeyMap[eventName as WhisperingSoundNames], v)}
						/>
						<Field.Label for="play-sound-{eventName}" class="flex-1 min-w-0">
							{eventLabels[eventName as WhisperingSoundNames]}
						</Field.Label>
						{#if availableSoundsQuery.isSuccess && sounds.length > 0}
							<div class="flex items-center gap-1 shrink-0">
								<Select.Root
									type="single"
									bind:value={() => settings.get(`sound.selectedSound.${eventName}` as any) as string,
										(v) => v != null && updateSelectedSound(eventName as WhisperingSoundNames, v)}
								>
									<Select.Trigger id="sound-select-{eventName}" class="w-40">
										{selectedSoundLabel(eventName as WhisperingSoundNames)}
									</Select.Trigger>
									<Select.Content>
										{#each sounds as sound (sound.id)}
											<Select.Item
												value={sound.id}
												label={sound.source === 'os' ? `${sound.name} (system)` : sound.name}
											>
												{sound.name}
												{#if sound.source === 'os'}
													<span class="text-muted-foreground text-xs"> (system)</span>
												{/if}
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
								<Button
									variant="ghost"
									size="icon"
									class="shrink-0"
									onclick={() => previewSound(settings.get(`sound.selectedSound.${eventName}` as any) as string)}
									disabled={previewMutation.isPending}
									tooltip="Preview sound"
								>
									<PlayIcon class="size-4" />
								</Button>
							</div>
						{/if}
					</Field.Field>
				{/each}
			</Field.Group>
		</Field.Set>
	</Field.Group>
</Field.Set>
