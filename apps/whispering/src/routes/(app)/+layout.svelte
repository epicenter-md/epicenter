<!--
	The (app) route layout is the boot node: the narrowest node that is NOT
	shared with `/auth/callback` or `/recording-overlay` (ADR-0345). It mounts
	once per launch and persists across navigation inside the group, so the
	store is opened once and the UI session is built once.

	It renders the four states of one data session (ADR-0344) rather than the
	three of an `{#await}` over an opener it started itself. The difference that
	matters is the retry: a failure is not memoized, so opening again is a real
	repair instead of a document reload sent to re-ask a question that was
	already answered.
-->
<script lang="ts">
	import { BootGate } from '@epicenter/app-shell/boot-gate';
	import { Loading } from '@epicenter/ui/loading';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { MediaQuery } from 'svelte/reactivity';
	import { auth, authClient } from '#platform/auth';
	import DictationIndicator from '#platform/dictation-indicator';
	import { epicenter } from '$lib/epicenter.svelte';
	import WhisperingUiSessionProvider from '$lib/whispering/WhisperingUiSessionProvider.svelte';
	import AppEffects from './_components/AppEffects.svelte';
	import BottomNav from './_components/BottomNav.svelte';
	import ContentShell from './_components/ContentShell.svelte';
	import GlobalDialogs from './_components/GlobalDialogs.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';

	let { children } = $props();

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');

	// Signed-out is read once, here, rather than tracked, and `authClient` is
	// what makes that structural: the raw client has no Svelte subscriber on it,
	// so this read cannot start tracking. A page lifetime is one auth generation
	// (ADR-0088): the root layout's `reloadOnAuthChange` replaces the document on
	// every transition that invalidates this boot, so a second, competing answer
	// to auth underneath it would be dead for the transitions that reload and
	// wrong for the one that deliberately does not. An account is required,
	// because a store is one replica of an authority (ADR-0336). A deep link
	// opened while signed out stays on its URL, and the post-sign-in reload lands
	// where the link pointed.
	const signedOut = authClient.state.status === 'signed-out';

	// Not awaited: what the open reports is `epicenter.state`, which is what
	// every branch below renders from.
	if (!signedOut) void epicenter.open();

	// The nouns the shared gate borrows. They are the application's, so they are
	// stated at the one node that renders the gate rather than in a package that
	// has never met the person reading them (ADR-0244). The erase description is
	// stated rather than templated because this one has to name the audio.
	const vocabulary = {
		appName: 'Whispering',
		subject: 'recordings',
		eraseDescription:
			'Every recording on this device will be deleted, along with its audio. Whatever had already reached the account they belong to is still there; anything that had not is gone. This action cannot be undone.',
	};
</script>

{#if signedOut}
	<BootGate {vocabulary} {auth} />
{:else if epicenter.state.status === 'ready'}
	<WhisperingUiSessionProvider data={epicenter.state.data}>
		<!-- Uses UI package defaults (300ms delay, 150ms skip) -->
		<Tooltip.Provider>
			<AppEffects />

			{#if isNarrow.current}
				<div class="flex h-full min-h-svh flex-col">
					<div class="flex-1 pb-14">
						<ContentShell>{@render children()}</ContentShell>
					</div>
					<BottomNav />
				</div>
			{:else}
				<Sidebar.Provider bind:open={sidebarOpen}>
					<VerticalNav />
					<Sidebar.Inset>
						<ContentShell>{@render children()}</ContentShell>
					</Sidebar.Inset>
				</Sidebar.Provider>
			{/if}

			<GlobalDialogs />
			<DictationIndicator />
		</Tooltip.Provider>
	</WhisperingUiSessionProvider>
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
	     for the one tick between this component initialising and the open above
	     starting, and there is nothing for them to do in it. -->
	<Loading class="h-dvh" />
{/if}
