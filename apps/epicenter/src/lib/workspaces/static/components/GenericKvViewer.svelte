<script lang="ts">
	import * as Y from 'yjs';
	import * as Card from '@epicenter/ui/card';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import { readKvValue } from '$lib/yjs/discover';

	type Props = {
		ydoc: Y.Doc;
		keys: string[];
		initialValues: Record<string, unknown>;
	};

	let { ydoc, keys, initialValues }: Props = $props();

	// Initialize state with initial data
	let values = $state(initialValues);

	// Set up Y.Array observer for live updates
	$effect(() => {
		const kvArray = ydoc.getArray('kv');

		const updateValues = () => {
			const newValues: Record<string, unknown> = {};
			for (const key of keys) {
				newValues[key] = readKvValue(ydoc, key);
			}
			values = newValues;
		};

		kvArray.observe(updateValues);

		return () => {
			kvArray.unobserve(updateValues);
		};
	});
</script>

<Card.Root>
	<Card.Header class="pb-3">
		<div class="flex items-center gap-2">
			<SettingsIcon class="text-muted-foreground size-4" />
			<Card.Title class="text-base">Settings</Card.Title>
		</div>
	</Card.Header>
	<Card.Content>
		<dl class="space-y-2">
			{#each keys as key (key)}
				<div
					class="bg-muted/50 flex items-start justify-between gap-4 rounded-md px-3 py-2"
				>
					<dt class="font-mono text-sm font-medium">{key}</dt>
					<dd class="text-muted-foreground text-right text-sm">
						{#if typeof values[key] === 'object'}
							<code class="text-xs">{JSON.stringify(values[key])}</code>
						{:else if values[key] === undefined}
							<span class="italic">undefined</span>
						{:else}
							{values[key]}
						{/if}
					</dd>
				</div>
			{/each}
		</dl>
	</Card.Content>
</Card.Root>
