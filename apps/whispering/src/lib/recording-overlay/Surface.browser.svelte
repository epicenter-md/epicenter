<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { whisperingPath } from '$lib/constants/urls';

	onMount(() => {
		void goto(whisperingPath('/'), { replaceState: true });
	});
</script>
