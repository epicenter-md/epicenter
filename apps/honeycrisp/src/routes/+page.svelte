<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { honeycrisp } from '#platform/epicenter';
	import AccountGate from './components/AccountGate.svelte';
	import StoreShell from './components/StoreShell.svelte';

	// The notes are here, at the one URL this application has. The generation
	// used to be a route parameter, resolved by `/account` and opened by
	// `/account/[generation]`; nobody chose that number, no link carried it, and
	// the handle resolves it now (ADR-0339), so the parameter and both routes
	// went with it.
	//
	// `honeycrisp` is composed in the platform leaf and nothing opens until this
	// renders. Signed-out is answered from one read of the account before
	// anything opens, so a person meeting the gate pays no Web Lock, no
	// IndexedDB, and no round trip. A deep link opened while signed out stays on
	// its URL, and the post-sign-in reload lands where the link pointed.
</script>

{#if honeycrisp.state.status === 'signed-out'}
	<AccountGate />
{:else if honeycrisp.state.status === 'opening'}
	<Loading class="h-dvh" label="Opening your notes…" />
{:else if honeycrisp.state.status === 'ready'}
	<StoreShell data={honeycrisp.state.data} />
{:else}
	<AccountGate
		error={honeycrisp.state.error}
		erase={honeycrisp.state.eraseReplica}
	/>
{/if}
