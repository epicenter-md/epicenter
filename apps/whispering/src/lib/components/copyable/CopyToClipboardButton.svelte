<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import type { Props } from '@epicenter/ui/button';
	import { rpc } from '$lib/query';
	import { createMutation } from '@tanstack/svelte-query';
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { Snippet } from 'svelte';

	const copyToClipboard = createMutation(rpc.text.copyToClipboard.options);

	let {
		children,
		copiedContent,
		textToCopy,
		contentDescription,
		viewTransitionName,
		class: className,
		size = 'icon',
		variant = 'ghost',
		disabled,
	}: {
		/**
		 * The content to display in the button's default state.
		 * This is mandatory and can contain any combination of text, icons, or other elements.
		 */
		children: Snippet;
		/**
		 * The content to display when the copy operation succeeds.
		 * Defaults to a check icon if not provided.
		 * Can also be text.
		 */
		copiedContent?: Snippet;
		/**
		 * The text that will be copied to the clipboard when the button is clicked.
		 */
		textToCopy: string;
		/**
		 * A description of the content being copied (e.g., "transcript", "API key").
		 * Used in tooltips and toast messages to provide context to the user.
		 */
		contentDescription: string;
		viewTransitionName?: string;
		class?: string;
	} & Partial<Pick<Props, 'disabled' | 'variant' | 'size'>> = $props();

	let isInCooldown = $state(false);
</script>

<WhisperingButton
	tooltipContent="Copy {contentDescription} to clipboard"
	onclick={() =>
		copyToClipboard.mutate(
			{ text: textToCopy },
			{
				onSuccess: () => {
					isInCooldown = true;
					setTimeout(() => {
						isInCooldown = false;
					}, 2000);
					rpc.notify.success.execute({
						title: `Copied ${contentDescription} to clipboard!`,
						description: textToCopy,
					});
				},
				onError: (error) => {
					rpc.notify.error.execute({
						title: `Error copying ${contentDescription} to clipboard`,
						description: error.message,
						action: { type: 'more-details', error },
					});
				},
			},
		)}
	style={viewTransitionName
		? `view-transition-name: ${viewTransitionName};`
		: undefined}
	class={className}
	{size}
	{variant}
	disabled={disabled || isInCooldown}
>
	<span class="sr-only">Copy</span>
	{#if isInCooldown}
		{#if copiedContent}
			{@render copiedContent()}
		{:else}
			<CheckIcon class="size-4" />
		{/if}
	{:else}
		{@render children()}
	{/if}
</WhisperingButton>
