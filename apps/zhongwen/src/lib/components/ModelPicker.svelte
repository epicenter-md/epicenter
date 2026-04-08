<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import type { ConversationHandle } from '$lib/chat/chat-state.svelte';
	import { PROVIDER_MODELS, type Provider } from '$lib/chat/providers';

	let { handle }: { handle: ConversationHandle } = $props();

	const providers = Object.keys(PROVIDER_MODELS) as Provider[];
	const models = $derived(PROVIDER_MODELS[handle.provider as Provider]);
</script>

<div class="flex items-center gap-1.5">
	<Select.Root
		type="single"
		value={handle.provider}
		onValueChange={(provider) => {
			if (provider) handle.provider = provider;
		}}
		disabled={handle.isLoading}
	>
		<Select.Trigger size="sm"> {handle.provider} </Select.Trigger>
		<Select.Content>
			{#each providers as p (p)}
				<Select.Item value={p} label={p} />
			{/each}
		</Select.Content>
	</Select.Root>

	<span class="text-sm text-muted-foreground">/</span>

	<Select.Root
		type="single"
		value={handle.model}
		onValueChange={(model) => {
			if (model) handle.model = model;
		}}
		disabled={handle.isLoading}
	>
		<Select.Trigger size="sm"> {handle.model} </Select.Trigger>
		<Select.Content>
			{#each models as m (m)}
				<Select.Item value={m} label={m} />
			{/each}
		</Select.Content>
	</Select.Root>
</div>
