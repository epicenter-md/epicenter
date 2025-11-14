<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { Database } from 'lucide-svelte';

	type Props = {
		hasIndicator?: boolean;
		onclick?: () => void;
	};

	let { hasIndicator = false, onclick }: Props = $props();
</script>

<WhisperingButton
	tooltipContent="Database Migration Manager"
	variant="ghost"
	size="icon"
	class="relative"
	{onclick}
>
	<Database class="size-4" aria-hidden="true" />
	{#if hasIndicator}
		<span
			class="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-amber-500 animate-ping"
		></span>
		<span
			class="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-amber-500"
		></span>
	{/if}
</WhisperingButton>
