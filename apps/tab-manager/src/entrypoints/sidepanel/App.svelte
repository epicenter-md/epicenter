<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { onDestroy } from 'svelte';
	import { openTabManagerApplication } from '$lib/application';
	import { tabManagerPlatform } from '$lib/application-platform';
	import TabManagerAppProvider from '$lib/TabManagerAppProvider.svelte';
	import TabManagerApp from './TabManagerApp.svelte';

	// This document owns the replica, so acquisition starts when this component
	// mounts and ends when it unmounts: closing the side panel releases the
	// DedicatedWorker, its Web Lock, and its OPFS file.
	const boot = new AbortController();
	const opening = openTabManagerApplication(tabManagerPlatform, {
		signal: boot.signal,
	});
	onDestroy(() => boot.abort());
</script>

{#await opening}
	<Loading class="h-full" label="Loading tabs…" />
{:then application}
	<TabManagerAppProvider {application}>
		<TabManagerApp />
	</TabManagerAppProvider>
{:catch error}
	<!-- The honest place for the already-open refusal: one document per storage
	     partition owns the replica (ADR-0165/ADR-0177), so a second side panel is
	     told no immediately rather than waiting on the first one's lifetime. The
	     message says which failure this was. -->
	<Empty.Root class="h-full border-0">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Tab Manager could not start</Empty.Title>
		<Empty.Description>
			{error instanceof Error ? error.message : String(error)}
		</Empty.Description>
		<Button size="sm" onclick={() => location.reload()}>Retry</Button>
	</Empty.Root>
{/await}

<ModeWatcher />
<Toaster position="bottom-center" richColors closeButton />
