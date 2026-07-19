<!--
	Mounted only in the fulfilled branch of the (app) layout's boot {#await}.
	Receives the fully ready application, composes the Svelte-side views on
	top, supplies the typed context synchronously during initialisation, and
	owns teardown of everything it composed.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { pushToTalk } from '$lib/operations/push-to-talk';
	import { log } from '$lib/report';
	import { createWhisperingRpc } from '$lib/rpc';
	import { createRecipes } from '$lib/state/recipes.svelte';
	import { createRecordings } from '$lib/state/recordings.svelte';
	import { createSettingsView } from '$lib/state/settings.svelte';
	import type { WhisperingApplication } from './application';
	import { setWhisperingApp, type WhisperingApp } from './context';

	let {
		application,
		children,
	}: {
		application: WhisperingApplication;
		children: Snippet;
	} = $props();

	// Intentional initial-value capture: one provider instance serves exactly
	// one resolved application; a new boot mounts a new provider.
	/* svelte-ignore state_referenced_locally */
	const recordings = createRecordings(application);
	/* svelte-ignore state_referenced_locally */
	const recipes = createRecipes(application);
	const app: WhisperingApp = {
		/* svelte-ignore state_referenced_locally */
		...application,
		/* svelte-ignore state_referenced_locally */
		settings: createSettingsView(application.settings),
		recordings,
		recipes,
	};
	setWhisperingApp({ ...app, rpc: createWhisperingRpc(app) });

	// A resolved application has one owner. Drain shell work before closing it.
	$effect(() => () => {
		void (async () => {
			try {
				await pushToTalk.dispose(app);
			} finally {
				await application[Symbol.asyncDispose]();
			}
		})()
			.catch((cause) =>
				log.warn(
					cause instanceof Error ? cause : new Error(String(cause)),
					'Whispering application teardown failed',
				),
			);
	});
</script>

{@render children()}
