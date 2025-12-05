<script lang="ts">
	import { Button, type Props } from '@epicenter/ui/button';
	import { mergeProps } from 'bits-ui';
	import { nanoid } from 'nanoid/non-secure';
	import type { Snippet } from 'svelte';
	import WhisperingTooltip from './WhisperingTooltip.svelte';

	let {
		id = nanoid(),
		children,
		tooltipContent,
		...buttonProps
	}: Props & { id?: string; tooltipContent: string | Snippet } = $props();
</script>

<WhisperingTooltip {id} {tooltipContent}>
	{#snippet trigger({ tooltipProps, tooltip })}
		<Button {...mergeProps(tooltipProps, buttonProps)}>
			{@render children?.()}
			<span class="sr-only">
				{@render tooltip()}
			</span>
		</Button>
	{/snippet}
</WhisperingTooltip>
