<script lang="ts">
	import type { BlobId } from '@epicenter/blobs';
	import type { AudioBlobUrl } from '$lib/services/blobs/types';
	import { services } from '$lib/services';

	let {
		id,
		enabled = true,
		class: className,
		viewTransitionName,
	}: {
		id: BlobId;
		enabled?: boolean;
		class?: string;
		viewTransitionName?: string;
	} = $props();

	let handle = $state<AudioBlobUrl | null>(null);

	$effect(() => {
		const requestedId = id;
		if (!enabled) {
			handle = null;
			return;
		}

		let cancelled = false;
		let owned: AudioBlobUrl | null = null;
		void services.blobUrls.open(requestedId).then(({ data }) => {
			if (data === null) return;
			if (cancelled) {
				data.dispose();
				return;
			}
			owned = data;
			handle = data;
		});

		return () => {
			cancelled = true;
			owned?.dispose();
			if (handle === owned) handle = null;
		};
	});
</script>

{#if handle}
	<audio
		class={className}
		style:view-transition-name={viewTransitionName}
		controls
		src={handle.url}
	>
		Your browser does not support the audio element.
	</audio>
{/if}
