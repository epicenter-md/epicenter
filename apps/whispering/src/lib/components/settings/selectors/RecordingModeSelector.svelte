<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import * as Command from '@repo/ui/command';
	import * as Popover from '@repo/ui/popover';
	import { useCombobox } from '@repo/ui/hooks';
	import {
		RECORDING_MODE_OPTIONS,
		type RecordingMode,
	} from '$lib/constants/audio';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/stores/settings.svelte';
	import { cn } from '@repo/ui/utils';
	import { CheckIcon, ChevronDown } from '@lucide/svelte';

	let { class: className }: { class?: string } = $props();

	const combobox = useCombobox();

	const availableModes = $derived(
		RECORDING_MODE_OPTIONS.filter((mode) => {
			if (!mode.desktopOnly) return true;
			// Desktop only, only show if Tauri is available
			return window.__TAURI_INTERNALS__;
		}),
	);

	const currentMode = $derived(
		availableModes.find(
			(mode) => mode.value === settings.value['recording.mode'],
		),
	);
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<WhisperingButton
				{...props}
				class={cn('relative', className)}
				tooltipContent={currentMode
					? `Recording mode: ${currentMode.label}`
					: 'Select recording mode'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				<ChevronDown class="size-4" />
			</WhisperingButton>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0 w-48">
		<Command.Root loop>
			<Command.List>
				<Command.Group>
					{#each availableModes as mode (mode.value)}
						{@const isSelected =
							settings.value['recording.mode'] === mode.value}
						<Command.Item
							value={mode.value}
							onSelect={async () => {
								await settings.switchRecordingMode(
									mode.value as RecordingMode,
								);
								combobox.closeAndFocusTrigger();
							}}
							class="flex items-center gap-2 px-2 py-2"
						>
							<CheckIcon
								class={cn('size-3.5 shrink-0', {
									'text-transparent': !isSelected,
								})}
							/>
							<span class="text-base">{mode.icon}</span>
							<span class="text-sm">{mode.label}</span>
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
