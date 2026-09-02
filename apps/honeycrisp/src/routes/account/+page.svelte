<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { auth } from '#platform/auth';
	import { resolveAccountGeneration } from '$lib/databases.js';
	import AccountGate from '../components/AccountGate.svelte';

	// Signed-out is a state of this place rather than a failure, and it is
	// answered before anything is resolved: an unauthenticated device cannot
	// ask an account which generations it has.
	const state = auth.state;
	const resolved =
		state.status === 'signed-out'
			? null
			: resolveAccountGeneration(auth, state.principalId);

	// Cache first, then the account's list (ADR-0292). A device holding a copy
	// never waits for a server to use it.
	$effect(() => {
		void resolved?.then((generation) =>
			goto(
				resolve('/account/[generation]', { generation: String(generation) }),
				{ replaceState: true },
			),
		);
	});
</script>

{#if resolved === null}
	<AccountGate />
{:else}
	{#await resolved}
		<Loading class="h-dvh" label="Opening your notes…" />
	{:then}
		<Loading class="h-dvh" label="Opening your notes…" />
	{:catch error}
		<AccountGate {error} />
	{/await}
{/if}
