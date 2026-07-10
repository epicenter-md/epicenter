<script lang="ts">
	import { onMount } from 'svelte';
	import type { RuntimeOwner } from '$lib/runtime/owner';

	let { owners }: { owners: readonly RuntimeOwner[] } = $props();
	onMount(() => {
		const detach = owners.map((owner) => owner.attach());
		return () => {
			for (const stop of detach.toReversed()) stop();
		};
	});
</script>
