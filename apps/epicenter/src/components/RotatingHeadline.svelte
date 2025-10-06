<script>
	import { fade } from 'svelte/transition';

	const terms = [
		'the Renaissance Mind',
		'Polymaths',
		'Interdisciplinary Thinkers',
		'Generalists',
		'the Endlessly Curious',
	];

	let currentIndex = $state(0);

	$effect(() => {
		const interval = setInterval(() => {
			currentIndex = (currentIndex + 1) % terms.length;
		}, 7000); // Change every 7 seconds

		return () => clearInterval(interval);
	});
</script>

<h1 class="text-4xl sm:text-5xl md:text-6xl font-bold mb-6 tracking-tight">
	Software for
	<span class="relative inline-block">
		{#each terms as term, index}
			{#if index === currentIndex}
				<span
					class="absolute left-0 top-0 whitespace-nowrap"
					in:fade={{ duration: 400 }}
					out:fade={{ duration: 400 }}
				>
					{term}
				</span>
			{/if}
		{/each}
		<!-- Invisible placeholder to maintain width -->
		<span class="invisible">Interdisciplinary Thinkers</span>
	</span>
</h1>
