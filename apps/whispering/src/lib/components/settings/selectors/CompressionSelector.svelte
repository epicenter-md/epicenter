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
	import { isCompressionRecommended } from '../../../../routes/(app)/_layout-utils/check-ffmpeg';
	import { SlidersIcon, SettingsIcon } from '@lucide/svelte';

	let {
		class: className,
		side = 'bottom' as 'top' | 'right' | 'bottom' | 'left',
		align = 'center' as 'start' | 'center' | 'end',
		showLabel = false,
		unstyled = false,
	}: {
		class?: string;
		side?: 'top' | 'right' | 'bottom' | 'left';
		align?: 'start' | 'center' | 'end';
		showLabel?: boolean;
		unstyled?: boolean;
	} = $props();

	const popover = useCombobox();

	// Check if we should show "Recommended" badge
	const shouldShowRecommendedBadge = $derived(isCompressionRecommended());

	// Visual state for the button icon
	const isCompressionEnabled = $derived(
		settings.value['transcription.compressionEnabled'],
	);

	// Tooltip text - only shows current value
	const tooltipText = $derived(isCompressionEnabled ? 'Enabled' : 'Disabled');

	// Label text - only shows setting name
	const labelText = 'Compression';
</script>

<Popover.Root bind:open={popover.open}>
	<Popover.Trigger bind:ref={popover.triggerRef}>
		{#snippet child({ props })}
			{#if unstyled}
				<button
					{...props}
					title={tooltipText}
					class={cn(
						'peer/menu-button outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm transition-[width,height,padding] [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
						'relative',
						className,
					)}
				>
					<div class="relative shrink-0">
						<SlidersIcon
							class={cn(
								'size-4 shrink-0',
								isCompressionEnabled ? 'opacity-100' : 'opacity-60',
							)}
						/>
						<!-- Recommended badge indicator -->
						{#if shouldShowRecommendedBadge}
							<span
								class="absolute -right-1.5 -top-1.5 size-2 rounded-full bg-blue-500 before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-blue-500/50 before:animate-ping"
							></span>
						{/if}
					</div>
					{#if showLabel}
						<span class="truncate min-w-0">{labelText}</span>
					{/if}
				</button>
			{:else}
				<WhisperingButton
					{...props}
					class={cn('relative', className)}
					tooltipContent={tooltipText}
					variant="ghost"
					size={showLabel ? 'default' : 'icon'}
				>
					<div class="relative shrink-0">
						<SlidersIcon
							class={cn(
								'size-4 shrink-0',
								isCompressionEnabled ? 'opacity-100' : 'opacity-60',
							)}
						/>
						<!-- Recommended badge indicator -->
						{#if shouldShowRecommendedBadge}
							<span
								class="absolute -right-1.5 -top-1.5 size-2 rounded-full bg-blue-500 before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-blue-500/50 before:animate-ping"
							></span>
						{/if}
					</div>
					{#if showLabel}
						<span class="truncate min-w-0">{labelText}</span>
					{/if}
				</WhisperingButton>
			{/if}
		{/snippet}
	</Popover.Trigger>

	<Popover.Content
		class="sm:w-[36rem] max-h-[40vh] overflow-auto p-0"
		{side}
		{align}
	>
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
