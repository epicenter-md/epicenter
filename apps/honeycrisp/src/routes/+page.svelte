<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '#platform/epicenter';
	import AccountGate from './components/AccountGate.svelte';
	import StoreShell from './components/StoreShell.svelte';

	// The notes are here, at the one URL this application has. The generation
	// used to be a route parameter, resolved by `/account` and opened by
	// `/account/[generation]`; nobody chose that number, no link carried it, and
	// the handle resolves it now (ADR-0339), so the parameter and both routes
	// went with it.
	//
	// `epicenter` is selected by the build and nothing opens until this renders.
	// Signed-out is answered from one read of the account before
	// anything opens, so a person meeting the gate pays no Web Lock, no
	// IndexedDB, and no round trip. A deep link opened while signed out stays on
	// its URL, and the post-sign-in reload lands where the link pointed.
</script>

{#if epicenter.boot.status === 'signed-out'}
	<AccountGate />
{:else if epicenter.boot.status === 'opening'}
	<Loading class="h-dvh" label="Opening your notes…" />
{:else if epicenter.boot.status === 'ready'}
	<StoreShell data={epicenter.boot.data} />
{:else}
	<AccountGate
		error={epicenter.boot.error}
		erase={epicenter.boot.eraseReplica}
	/>
{/if}
