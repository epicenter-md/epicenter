<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { workspace } from '$lib/client';
	import '@epicenter/ui/app.css';
	import * as Tooltip from '@epicenter/ui/tooltip';

	let { children } = $props();
</script>

<svelte:head><title>Fuji</title></svelte:head>

<WorkspaceGate whenReady={workspace.whenReady}>
	<Tooltip.Provider>{@render children()}</Tooltip.Provider>
</WorkspaceGate>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
