<script lang="ts">
	import { onMount } from 'svelte';

	let { owners }: { owners: readonly (() => () => void)[] } = $props();
	onMount(() => {
		const detach: Array<() => void> = [];
		try {
			for (const attach of owners) detach.push(attach());
		} catch (error) {
			for (const stop of detach.toReversed()) stop();
			throw error;
		}
		return () => {
			for (const stop of detach.toReversed()) stop();
		};
	});
</script>
