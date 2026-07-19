<script lang="ts">
	import '../app.css';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { toast, Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { openSkillsApplication, skillsBrowser } from '$lib/application.js';
	import SkillsAppProvider from '$lib/SkillsAppProvider.svelte';

	let { children } = $props();

	const boot = new AbortController();
	const opening = openSkillsApplication(
		{
			...skillsBrowser,
			reportBackgroundError(cause) {
				toast.error('Skills background refresh failed', {
					description: cause instanceof Error ? cause.message : String(cause),
				});
			},
		},
		{ signal: boot.signal },
	);
	$effect(() => () => boot.abort());
</script>

<ConfirmationDialog />
<Toaster />
<ModeWatcher />
{#await opening}
	<Loading class="h-dvh" />
{:then application}
	<SkillsAppProvider {application}>{@render children()}</SkillsAppProvider>
{:catch error}
	<div class="flex h-dvh items-center justify-center p-6">
		<div class="max-w-md space-y-3 text-center">
			<h1 class="text-lg font-semibold">Could not open Skills</h1>
			<p class="text-sm text-muted-foreground">
				{error instanceof Error ? error.message : String(error)}
			</p>
			<button class="underline" onclick={() => location.reload()}>Reload</button>
		</div>
	</div>
{/await}
