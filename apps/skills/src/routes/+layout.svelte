<script lang="ts">
	import '../app.css';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { openSkillsRuntime } from '$lib/application.js';
	import SkillsAppProvider from '$lib/SkillsAppProvider.svelte';

	let { children } = $props();

	// One transactional open acquired during layout initialisation, with a raw
	// `{#await}` owning pending, ready and failure; descendants receive the
	// READY runtime through a typed context, so there is no module-scope boot
	// and no half-open handle.
	//
	// Gated rather than skeletoned because there is no useful partial UI: a
	// route on an unopened store reads an empty table and flashes "no skills
	// yet" at someone whose skills are about to appear.
	const boot = new AbortController();
	const opening = openSkillsRuntime({ signal: boot.signal });
	$effect(() => () => boot.abort());
</script>

<ConfirmationDialog />
<Toaster />
<ModeWatcher defaultMode="dark" track={false} />
{#await opening}
	<Loading class="h-dvh" />
{:then runtime}
	<SkillsAppProvider {runtime}>{@render children()}</SkillsAppProvider>
{:catch error}
	<div class="flex h-dvh items-center justify-center p-6">
		<div class="max-w-md space-y-3 text-center">
			<h1 class="text-lg font-semibold">Could not open Skills</h1>
			<p class="text-sm text-muted-foreground">
				<!-- `extractErrorMessage`, not `String(error)`: a tagged error is a
				     plain object with a `message`, so stringifying one renders
				     "[object Object]" and hides the only useful thing it carries. -->
				{extractErrorMessage(error)}
			</p>
			<button class="underline" onclick={() => location.reload()}>Reload</button>
		</div>
	</div>
{/await}
