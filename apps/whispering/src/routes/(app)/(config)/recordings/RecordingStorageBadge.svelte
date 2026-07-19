<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/rpc';
	import type { Recording } from '$lib/state/recordings.svelte';

	let {
		recording,
	}: {
		recording: Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>;
	} = $props();

	const availability = createQuery(
		() => rpc.audio.availability(() => recording).options,
	);

	const labels = {
		'local-only': 'On this device',
		'local-and-remote': 'Device + online',
		'remote-only': 'Online only',
		unavailable: 'Audio missing',
	} as const;
</script>

{#if availability.data}
	<Badge variant={availability.data === 'unavailable' ? 'destructive' : 'secondary'}>
		{labels[availability.data]}
	</Badge>
{:else if availability.isError}
	<Badge variant="destructive">Storage error</Badge>
{:else}
	<Badge variant="secondary">Checking...</Badge>
{/if}
