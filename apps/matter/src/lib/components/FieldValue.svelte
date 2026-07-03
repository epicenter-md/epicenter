<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import type { Kind } from '@epicenter/field';

	let { kind, value }: { kind: Kind; value: unknown } = $props();

	const isEmpty = $derived(value === null || value === undefined || value === '');
	const text = $derived(typeof value === 'string' ? value : String(value));
	const values = $derived(
		Array.isArray(value) ? value.map((item) => String(item)) : [],
	);
	const jsonText = $derived.by(() => {
		if (value === undefined) return undefined;
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	});
</script>

{#if isEmpty}
	<span class="text-muted-foreground/50">.</span>
{:else if kind === 'boolean'}
	<span>{value ? 'true' : 'false'}</span>
{:else if kind === 'tags' || kind === 'multiSelect'}
	{#if values.length}
		<div class="flex min-w-0 flex-wrap gap-1">
			{#each values as item, i (i)}
				<Badge variant="secondary" class="max-w-40 truncate rounded-md font-normal">
					{item}
				</Badge>
			{/each}
		</div>
	{:else}
		<span class="block truncate">{text}</span>
	{/if}
{:else if kind === 'json' || typeof value === 'object'}
	<code class="block max-w-full truncate text-xs text-muted-foreground">
		{jsonText}
	</code>
{:else if kind === 'url'}
	<a
		href={text}
		target="_blank"
		rel="noreferrer"
		class="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
	>
		<span class="truncate">{text}</span>
		<ExternalLinkIcon class="size-3 shrink-0" />
	</a>
{:else}
	<span class="block truncate">{text}</span>
{/if}
