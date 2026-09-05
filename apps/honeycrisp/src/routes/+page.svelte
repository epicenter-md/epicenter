<script lang="ts">
	import { BootGate } from '@epicenter/app-shell/boot-gate';
	import { Loading } from '@epicenter/ui/loading';
	import { auth, authClient } from '#platform/auth';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import StoreShell from './components/StoreShell.svelte';

	// The notes are here, at the one URL this application has. The generation
	// used to be a route parameter, resolved by `/account` and opened by
	// `/account/[generation]`; nobody chose that number, no link carried it, and
	// the handle resolves it now (ADR-0339), so the parameter and both routes
	// went with it.
	//
	// **This is where the notes are opened, and the call is explicit.** It is
	// this route rather than the layout because the layout also wraps
	// `/auth/callback`, which must claim no Web Lock, touch no IndexedDB, and
	// make no round trip on its way through. This is the narrowest node that is
	// not shared with the callback, and Honeycrisp's protected surface is one
	// route at `/`, so that node is the page (ADR-0345).
	//
	// Signed-out is read once, here, rather than tracked, and `authClient` is
	// what makes that structural: the raw client has no Svelte subscriber on it,
	// so this read cannot start tracking. A page lifetime is one
	// auth generation (ADR-0088): the layout's `reloadOnAuthChange` replaces the
	// document on every transition that invalidates this page, so a second,
	// competing answer to auth underneath it would be dead for the transitions
	// that reload and wrong for the one that deliberately does not. A deep link
	// opened while signed out stays on its URL, and the post-sign-in reload
	// lands where the link pointed.
	const signedOut = authClient.state.status === 'signed-out';

	// Not awaited: what the open reports is `epicenter.state`, which is what
	// every branch below renders from.
	if (!signedOut) void epicenter.open();

	// The nouns the shared gate borrows. They are the application's, so they are
	// stated at the one node that renders the gate rather than in a package that
	// has never met the person reading them (ADR-0244).
	const vocabulary = {
		appName: 'Honeycrisp',
		subject: 'notes',
		eraseDescription:
			'Every note on this device will be deleted. Whatever had already reached the account they belong to is still there; anything that had not is gone. This action cannot be undone.',
	};
</script>

{#if signedOut}
	<BootGate {vocabulary} {auth} />
{:else if epicenter.state.status === 'ready'}
	<StoreShell data={epicenter.state.data} />
{:else if epicenter.state.status === 'failed'}
	<BootGate
		{vocabulary}
		{auth}
		error={epicenter.state.error}
		erase={epicenter.state.eraseReplica}
		retry={() => void epicenter.open()}
	/>
{:else}
	<!-- `closed` and `opening` are one screen. A signed-in person meets `closed`
	     for the one tick between this module evaluating and the open above
	     starting, and there is nothing for them to do in it. -->
	<Loading class="h-dvh" label="Opening your notes…" />
{/if}
