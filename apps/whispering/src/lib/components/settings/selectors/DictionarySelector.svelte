<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import { goto } from '$app/navigation';
	import { getDictionary } from '$lib/utils/dictionary';
	import { settings } from '$lib/state/settings.svelte';

	let { class: className }: { class?: string } = $props();

	const count = $derived(
		(() => {
			settings.get('transcription.dictionary');
			return getDictionary().length;
		})(),
	);
</script>

<Button
	variant="ghost"
	size="icon"
	class={cn('relative', className)}
	tooltip={count > 0 ? `Dictionary — ${count} ${count === 1 ? 'entry' : 'entries'}` : 'Dictionary — empty'}
	onclick={() => goto('/settings/dictionary')}
>
	<BookOpenIcon class="size-4" />
	{#if count > 0}
		<span
			class="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground"
		>
			{count > 9 ? '9+' : count}
		</span>
	{/if}
</Button>
