<script lang="ts">
	import {
		CannotOpenScreen,
		SignInScreen,
	} from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { authClient } from '$lib/platform/auth';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import VocabShell from './components/VocabShell.svelte';

	// The boot node: it opens the store and renders the four states of that
	// session. Vocab's protected surface is one route at `/`, so the page is the
	// narrowest node not shared with `/auth/callback` (ADR-0345).
	//
	// The screens are `@epicenter/app-shell/boot-screens`, which take the two
	// words that are Vocab's: its name, and `conversations`. See
	// `apps/honeycrisp/src/routes/+page.svelte` for why `authClient` rather than
	// `auth`.
	const signedOut = authClient.state.status === 'signed-out';

	if (!signedOut) void epicenter.open();
</script>

{#if signedOut}
	<SignInScreen auth={authClient} appName="Vocab" noun="conversations" />
{:else if epicenter.state.status === 'ready'}
	<VocabShell data={epicenter.state.data} />
{:else if epicenter.state.status === 'failed'}
	<CannotOpenScreen
		appName="Vocab"
		noun="conversations"
		error={epicenter.state.error}
		retry={() => void epicenter.open()}
	/>
{:else}
	<!-- `closed` and `opening` are one screen; `closed` is unreachable during a
	     boot, and the one caller that returns a session to it reopens on
	     failure. -->
	<Loading class="h-dvh" label="Opening your conversations…" />
{/if}
