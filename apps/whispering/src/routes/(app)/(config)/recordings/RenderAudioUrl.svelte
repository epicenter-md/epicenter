<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { readFile } from '@tauri-apps/plugin-fs';

	let { id }: { id: string } = $props();

	const audioPlaybackUrlQuery = createQuery(
		() => rpc.db.recordings.getAudioPlaybackUrl(() => id).options,
	);

	const audioPlaybackUrl = $derived(audioPlaybackUrlQuery.data);
	let blobUrl: string | undefined = $state(undefined);

	$effect(() => {
		if (audioPlaybackUrl !== undefined) {
			// Convert the path from asset://localhost/some/path to just be /some/path/to/file
			const encodedPath = audioPlaybackUrl.slice('asset://localhost/'.length);
			const filePath = decodeURIComponent(encodedPath);

			// Read the audio data in this file and then directly set that as the blob URL
			readFile(filePath).then((data) => {
				const fileBlob = new Blob([data]);
				const reader = new FileReader();
				reader.readAsDataURL(fileBlob);
				const url = URL.createObjectURL(fileBlob);
				blobUrl = url;
			});
		}
	});

	onDestroy(() => {
		// Clean up audio URL when component unmounts to prevent memory leaks
		services.db.recordings.revokeAudioUrl(id);
	});
</script>

{#if blobUrl}
	<audio
		class="h-8"
		style="view-transition-name: {viewTransition.recording(id).audio}"
		controls
		src={blobUrl}
	>
		Your browser does not support the audio element.
	</audio>
{/if}
