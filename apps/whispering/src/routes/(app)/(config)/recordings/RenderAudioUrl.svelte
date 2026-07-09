<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { viewTransition } from '$lib/utils/viewTransitions';
    import AudioPlayer from '$lib/components/audio/AudioPlayer.svelte';

	let { id }: { id: string } = $props();

	const audioUrlQuery = createQuery(
		() => rpc.audio.getPlaybackUrl(() => id).options,
	);

	onDestroy(() => {
		// Clean up audio URL when component unmounts to prevent memory leaks
		services.blobs.audio.revokeUrl(id);
	});
</script>

{#if audioUrlQuery.data}
	<AudioPlayer src={audioUrlQuery.data} />
{/if}
