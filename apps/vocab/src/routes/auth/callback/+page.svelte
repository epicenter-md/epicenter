<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { authClient } from '$lib/platform/auth';

	// Completion only, and it opens nothing: the store is opened by
	// `+page.svelte`, which is a sibling under the same chrome-only root layout
	// (ADR-0345).
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			if (!isCallbackAuthClient(authClient)) {
				errorMessage = 'This build does not sign in through a browser callback.';
				return;
			}
			const { error } = await authClient.completeSignIn();
			if (error) {
				errorMessage = error.message;
				return;
			}
			// A document replacement rather than `goto`: a new auth generation is a
			// new document (ADR-0088), and this is also the only thing that leaves
			// the callback URL when the callback completed for the principal
			// already signed in, which publishes no state change to reload on.
			window.location.replace('/');
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
