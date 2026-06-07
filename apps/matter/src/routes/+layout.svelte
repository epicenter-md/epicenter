<script lang="ts">
	import '@epicenter/ui/app.css';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';

	let { children } = $props();
</script>

<svelte:head><title>Matter</title></svelte:head>

<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>

<ModeWatcher defaultMode="dark" track={false} />
