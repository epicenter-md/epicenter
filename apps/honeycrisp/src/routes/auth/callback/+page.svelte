<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { authClient } from '#platform/auth';
	import { resolve } from '$app/paths';

	// Completion only. This route renders under the root layout, which is chrome
	// (ADR-0345), so nothing above it opens a store; the notes are opened by
	// `+page.svelte`, which is a sibling.
	//
	// `completeSignIn`, not `startSignIn`: starting always starts now, so asking
	// it to finish a callback would mint a fresh PKCE transaction and redirect
	// straight back here.
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			if (!isCallbackAuthClient(authClient)) {
				// The desktop build signs in through the host, which relaunches the
				// process, so no browser callback lands here.
				errorMessage = 'This build does not sign in through a browser callback.';
				return;
			}
			const { error } = await authClient.completeSignIn();
			if (error) {
				errorMessage = error.message;
				return;
			}
			// A document replacement rather than `goto`, because a new auth
			// generation is a new document (ADR-0088). The layout's
			// `reloadOnAuthChange` has usually done it already; this is what covers
			// the callback that completed for the principal already signed in,
			// which changes no state and therefore reloads nothing.
			window.location.replace(resolve('/'));
		})();
	});
</script>

{#if errorMessage}
	<div
		class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive"
	>
		{errorMessage}
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
