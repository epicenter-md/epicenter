<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import type { Snippet } from 'svelte';

	let {
		children,
		class: className,
	}: {
		children: Snippet;
		class?: string;
	} = $props();
</script>

<div
	class={cn('flex w-full items-center gap-1.5', className)}
	role="group"
	aria-label="Recording setup"
>
	{@render children()}
</div>
