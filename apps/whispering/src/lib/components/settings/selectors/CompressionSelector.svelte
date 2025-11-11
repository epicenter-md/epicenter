<script lang="ts">
	import { goto } from '$app/navigation';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { CompressionBody } from '$lib/components/settings';
	import * as Popover from '@repo/ui/popover';
	import { Button } from '@repo/ui/button';
	import { Separator } from '@repo/ui/separator';
	import { useCombobox } from '@repo/ui/hooks';
	import { settings } from '$lib/stores/settings.svelte';
	import { cn } from '@repo/ui/utils';
	import { isCompressionRecommended } from '$routes/(app)/_layout-utils/check-ffmpeg';
	import { PackageIcon, SettingsIcon } from '@lucide/svelte';

	let { class: className }: { class?: string } = $props();

	const popover = useCombobox();

	// Check if we should show "Recommended" badge
	const shouldShowRecommendedBadge = $derived(isCompressionRecommended());

	// Visual state for the button icon
	const isCompressionEnabled = $derived(
		settings.value['transcription.compressionEnabled'],
	);
</script>

<Popover.Root bind:open={popover.open}>
	<Popover.Trigger bind:ref={popover.triggerRef}>
		{#snippet child({ props })}
			<WhisperingButton
				{...props}
				class={cn('relative', className)}
				tooltipContent={isCompressionEnabled
					? 'Compression enabled - click to configure'
					: 'Audio compression disabled - click to enable'}
				variant="ghost"
				size="icon"
			>
				<PackageIcon
					class={cn(
						'text-lg',
						isCompressionEnabled ? 'opacity-100' : 'opacity-60',
					)}
				>
					🗜️
				</PackageIcon>

				<!-- Recommended badge indicator -->
				{#if shouldShowRecommendedBadge}
					<span
						class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-blue-500 before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-blue-500/50 before:animate-ping"
					></span>
				{/if}
			</WhisperingButton>
		{/snippet}
	</Popover.Trigger>

	<Popover.Content class="sm:w-[36rem] max-h-[40vh] overflow-auto p-0">
		<div class="p-4">
			<CompressionBody />
		</div>
		<Separator />
		<Button
			variant="ghost"
			size="sm"
			class="w-full justify-start text-muted-foreground rounded-none"
			onclick={() => {
				goto('/settings/transcription');
				popover.open = false;
			}}
		>
			<SettingsIcon class="mr-2 h-4 w-4" />
			Configure in transcription settings
		</Button>
	</Popover.Content>
</Popover.Root>
