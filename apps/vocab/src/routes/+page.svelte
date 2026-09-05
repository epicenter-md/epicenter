<script lang="ts">
	import { BootGate } from '@epicenter/app-shell/boot-gate';
	import { Loading } from '@epicenter/ui/loading';
	import { auth, authClient } from '$lib/platform/auth';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import VocabShell from './components/VocabShell.svelte';

	// **This is where the store is opened, and the call is explicit**
	// (ADR-0344). It replaces the `{#await}` over an open the layout started
	// during its own initialisation: opening is a verb now, so the states are
	// read off `epicenter.state` and a failure is retried by opening again
	// rather than by reloading the document. Vocab's protected surface is one
	// route at `/`, so the page is the narrowest node not shared with
	// `/auth/callback`, and no route group would add one (ADR-0345).
	//
	// Signed-out is read once, here, rather than tracked, and `authClient` is
	// what makes that structural: the raw client has no Svelte subscriber on it,
	// so this read cannot start tracking. A page lifetime is one
	// auth generation (ADR-0088): the layout's `reloadOnAuthChange` replaces the
	// document on every transition that invalidates this page. An account is
	// required, so a signed-out person has nothing to open and is asked to sign
	// in rather than handed a local pool that could never be synced.
	const signedOut = authClient.state.status === 'signed-out';

	if (!signedOut) void epicenter.open();

	// The nouns the shared gate borrows. `conversations` is the word this
	// application already syncs under, in `VocabSidebar`'s account popover.
	//
	// This screen used to be hand-rolled here: `extractErrorMessage` under one
	// Try again, with no arm for a second window, no arm for a browser without
	// Web Locks, and no erase. A copy belonging to another account was a dead
	// end, because `epicenter.state.eraseReplica` was never offered to anyone.
	const vocabulary = {
		appName: 'Vocab',
		subject: 'conversations',
		eraseDescription:
			'Every conversation and entry on this device will be deleted. Whatever had already reached the account they belong to is still there; anything that had not is gone. This action cannot be undone.',
	};
</script>

{#if signedOut}
	<BootGate {vocabulary} {auth} />
{:else if epicenter.state.status === 'ready'}
	<VocabShell data={epicenter.state.data} />
{:else if epicenter.state.status === 'failed'}
	<BootGate
		{vocabulary}
		{auth}
		error={epicenter.state.error}
		erase={epicenter.state.eraseReplica}
		retry={() => void epicenter.open()}
	/>
{:else}
	<!-- `closed` and `opening` are one screen. -->
	<Loading class="h-dvh" />
{/if}
