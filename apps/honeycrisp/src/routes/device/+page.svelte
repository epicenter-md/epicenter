<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { resolveLocalGeneration } from '$lib/databases.js';
	import StoreFailure from '../components/StoreFailure.svelte';

	// Which generation, decided once and then in the URL (ADR-0285). The
	// opener below takes an exact number and never discovers one, so this is
	// the one place the question is asked: the newest copy this device holds,
	// or a fresh one imported from nothing if it holds none.
	//
	// Resolved rather than redirected-from-a-guess, because a number in a URL
	// is an address: sending somebody to `/device/1` before knowing 1 exists
	// would be asking the opener to invent it.
	const resolved = resolveLocalGeneration();
	$effect(() => {
		void resolved.then((generation) =>
			goto(resolve('/device/[generation]', { generation: String(generation) }), {
				replaceState: true,
			}),
		);
	});
</script>

{#await resolved}
	<Loading class="h-dvh" label="Opening notes on this device…" />
{:then}
	<Loading class="h-dvh" label="Opening notes on this device…" />
{:catch error}
	<StoreFailure store="local" {error} />
{/await}
