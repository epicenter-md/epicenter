<script lang="ts">
	import type { BlobId } from '@epicenter/blobs';
	import AudioBlobPlayer from '$lib/components/AudioBlobPlayer.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import type { RecordingId } from '$lib/data';

	let { id, audioBlobId }: { id: RecordingId; audioBlobId: BlobId } = $props();
</script>

<AudioBlobPlayer
	id={audioBlobId}
	class="h-8"
	viewTransitionName={viewTransition.recording(id).audio}
/>
