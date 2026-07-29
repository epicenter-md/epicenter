<script lang="ts">
	import { openVocabBrowserEpicenter } from '@epicenter/vocab/browser';
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { toast, Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onDestroy } from 'svelte';
	import { openVocabApplication } from '$lib/application';
	import { auth } from '$lib/platform/auth';
	import VocabAppProvider from '$lib/VocabAppProvider.svelte';
	import '../app.css';

	let { children } = $props();

	function reportBackgroundError(cause: unknown) {
		toast.error('Vocab background work failed', {
			description: cause instanceof Error ? cause.message : String(cause),
		});
	}

	const boot = new AbortController();
	// One replica either way (ADR-0088): signing in attaches a sync session to
	// the replica already open, so an identity change no longer reloads the page.
	const opening = openVocabApplication(
		{
			openEpicenter: () =>
				openVocabBrowserEpicenter({ auth, reportBackgroundError }),
			reportBackgroundError,
		},
		{ signal: boot.signal },
	);
	onDestroy(() => boot.abort());
</script>

<svelte:head><title>Vocab</title></svelte:head>

{#await opening}
	<Loading class="h-dvh" />
{:then application}
	<VocabAppProvider {application}>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
	</VocabAppProvider>
{:catch error}
	<div
		class="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center"
	>
		<h1 class="text-lg font-semibold">Vocab could not start</h1>
		<p class="text-muted-foreground max-w-md text-sm">
			{error instanceof Error ? error.message : String(error)}
		</p>
		<div class="flex gap-2">
			<Button onclick={() => location.reload()}>Reload</Button>
			<Button variant="outline" onclick={() => auth.signOut()}>Sign out</Button>
		</div>
	</div>
{/await}

<Toaster />
<ConfirmationDialog />
<ModeWatcher />
<FlushEditsOnHide />
