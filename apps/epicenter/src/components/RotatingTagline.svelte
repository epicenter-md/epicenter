<script lang="ts">
	import { cn } from '@repo/ui/utils';
	import { fly, blur } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	const audiences = [
		'interdisciplinary thinkers',
		'polymaths',
		'the endlessly curious',
		'generalists',
		'the liberal arts',
	];

	type Props = {
		class?: string;
	};

	let { class: className }: Props = $props();
	let currentIndex = $state(0);

	$effect(() => {
		const interval = setInterval(() => {
			currentIndex = (currentIndex + 1) % audiences.length;
		}, 2500); // Rotate faster - every 2.5 seconds

		return () => clearInterval(interval);
	});
</script>

<h2
	class={cn(
		'flex items-center justify-center text-2xl font-medium text-foreground',
		className,
	)}
>
	<span>Software for</span>
	<div class="relative ml-2 h-10 inline-flex">
		{#key currentIndex}
			<span
				in:fly={{ y: 30, duration: 600, easing: cubicOut }}
				out:fly={{ y: -30, duration: 600, easing: cubicOut }}
				class="absolute left-0 flex h-full items-center whitespace-nowrap"
			>
				{audiences[currentIndex]}
			</span>
		{/key}
	</div>
</h2>
