<script lang="ts">
	import { rpc } from '$lib/query';
	import * as services from '$lib/services';
	import { getRecordingTransitionId } from '$lib/utils/getRecordingTransitionId';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';

	let { id }: { id: string } = $props();

	const audioUrlQuery = createQuery(
		rpc.db.recordings.getAudioPlaybackUrl(() => id).options,
	);

	onDestroy(() => {
		// Clean up audio URL when component unmounts to prevent memory leaks
		services.db.recordings.revokeAudioUrl(id);
	});
</script>

{#if audioUrlQuery.data}
	<audio
		class="h-8"
		style="view-transition-name: {getRecordingTransitionId({
			recordingId: id,
			propertyName: 'id',
		})}"
		controls
		src={audioUrlQuery.data}
	>
		Your browser does not support the audio element.
	</audio>
{/if}
