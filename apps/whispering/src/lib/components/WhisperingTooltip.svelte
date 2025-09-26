<script lang="ts">
	import * as Tooltip from '@repo/ui/tooltip';
	import { mergeProps } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		id,
		trigger,
		tooltipContent,
		...restProps
	}: {
		id: string;
		trigger: Snippet<
			[{ tooltipProps: Record<string, unknown>; tooltip: Snippet<[]> }]
		>;
		tooltipContent: string | Snippet;
	} = $props();
</script>

{#snippet tooltip()}
	{#if typeof tooltipContent === 'string'}
		{tooltipContent}
	{:else}
		{@render tooltipContent()}
	{/if}
{/snippet}

<Tooltip.Root>
	<Tooltip.Trigger {id}>
		{#snippet child({ props: tooltipProps })}
			{@render trigger?.({
				tooltipProps: mergeProps(tooltipProps, restProps),
				tooltip,
			})}
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content class="max-w-xs text-center">
		{@render tooltip()}
	</Tooltip.Content>
</Tooltip.Root>
