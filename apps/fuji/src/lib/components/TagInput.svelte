<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import XIcon from '@lucide/svelte/icons/x';

	let {
		values,
		placeholder,
		onAdd,
		onRemove,
	}: {
		values: string[];
		placeholder?: string;
		onAdd: (value: string) => void;
		onRemove: (value: string) => void;
	} = $props();

	let inputValue = $state('');
</script>

<div
	class="flex min-h-8 flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1 text-sm ring-offset-background focus-within:ring-1 focus-within:ring-ring"
>
	{#each values as value (value)}
		<Badge variant="secondary" class="gap-1 pr-1">
			{value}
			<button
				type="button"
				class="rounded-full p-0.5 hover:bg-muted"
				onclick={() => onRemove(value)}
			>
				<XIcon class="size-3" />
			</button>
		</Badge>
	{/each}
	<input
		type="text"
		class="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
		placeholder={values.length === 0 ? placeholder : ''}
		bind:value={inputValue}
		onkeydown={(e) => {
		if (e.key === 'Enter' && inputValue.trim()) {
			e.preventDefault();
			const value = inputValue.trim().toLowerCase();
			if (!values.includes(value)) {
				onAdd(value);
			}
			inputValue = '';
		}
		if (e.key === 'Backspace' && !inputValue && values.length > 0) {
			onRemove(values[values.length - 1]!);
		}
	}}
	>
</div>
