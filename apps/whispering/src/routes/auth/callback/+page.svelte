<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { resolve } from '$app/paths';
	import { authClient } from '#platform/auth';

	// The one thing this route does, and it opens nothing: no store, no Web
	// Lock, no IndexedDB (ADR-0345). It renders under the root layout alone,
	// beside the `(app)` group rather than inside it.
	//
	// `completeSignIn`, not `startSignIn`. Starting used to mean finishing here,
	// because the browser launcher inspected the URL for a `code` first; asking
	// to begin a sign-in in order to end one is now a redirect loop rather than
	// a subtlety, since starting always starts.
	//
	// `authClient` rather than `auth`: this calls a verb and renders nothing off
	// auth state, so there is nothing to track.
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			if (!isCallbackAuthClient(authClient)) {
				// The desktop build. Its sign-in goes through the host, which
				// relaunches the process with the new identity, so no browser
				// callback ever lands here and this sentence is unreachable in
				// practice. It exists because one route file is compiled into every
				// build and pretending otherwise would be a cast.
				errorMessage = 'This build does not sign in through a browser callback.';
				return;
			}
			const { error } = await authClient.completeSignIn();
			if (error) {
				errorMessage = error.message;
				return;
			}
			// A document replacement, not `goto`. Completing publishes the new auth
			// state before this resumes, so the root layout's `reloadOnAuthChange`
			// has usually replaced the document already and this is a harmless
			// supersede. What it is NOT redundant for is a callback that finished
			// for the principal already signed in: no state changed, nothing
			// reloaded, and this is the only thing that leaves the callback URL. A
			// client-side navigation would have kept this document alive and opened
			// the store inside one the browser was about to unload.
			// `resolve`, not a literal '/': the Epicenter build serves this app
			// under a base path, so the root of THIS app is not the origin's.
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
