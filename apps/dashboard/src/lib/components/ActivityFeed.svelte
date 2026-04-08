<script lang="ts">
	import { Skeleton } from '@epicenter/ui/skeleton';
	import * as Table from '@epicenter/ui/table';
	import { createQuery } from '@tanstack/svelte-query';
	import { eventsQueryOptions } from '$lib/query/billing';

	const events = createQuery(() => eventsQueryOptions({ limit: 50 }));

	/** Autumn stores timestamp as epoch ms. */
	function formatTimestamp(ts: number): string {
		return new Date(ts).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}

	/** Properties are JSONB—model/provider are custom keys we send via autumn.check(). */
	function prop(
		event: { properties: Record<string, never> },
		key: string,
	): string {
		return (event.properties as Record<string, string>)[key] ?? '—';
	}
</script>

{#if events.isPending}
	<div class="space-y-2">
		{#each Array(10) as _}
			<Skeleton class="h-8 w-full" />
		{/each}
	</div>
{:else if events.isError}
	<p class="text-sm text-destructive">Failed to load activity.</p>
{:else if !events.data?.list.length}
	<p class="text-sm text-muted-foreground py-8 text-center">No activity yet.</p>
{:else}
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Time</Table.Head>
				<Table.Head>Model</Table.Head>
				<Table.Head>Provider</Table.Head>
				<Table.Head class="text-right">Credits</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each events.data.list as event}
				<Table.Row>
					<Table.Cell class="text-xs text-muted-foreground whitespace-nowrap">
						{formatTimestamp(event.timestamp)}
					</Table.Cell>
					<Table.Cell class="font-mono text-xs">
						{prop(event, 'model')}
					</Table.Cell>
					<Table.Cell class="text-xs text-muted-foreground">
						{prop(event, 'provider')}
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">
						{event.value}
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
{/if}
