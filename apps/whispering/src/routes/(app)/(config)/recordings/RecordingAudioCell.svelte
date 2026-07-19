<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/rpc';
	import type { Recording } from '$lib/state/recordings.svelte';
	import RenderAudioUrl from './RenderAudioUrl.svelte';

	let { recording }: { recording: Recording } = $props();
	const availability = createQuery(
		() => rpc.audio.availability(() => recording).options,
	);
</script>

{#if availability.data === 'local-only' || availability.data === 'local-and-remote'}
	<RenderAudioUrl id={recording.id} audioBlobId={recording.audioBlobId} />
{:else if availability.data}
	<span class="text-muted-foreground text-sm">Not on this device</span>
{/if}
