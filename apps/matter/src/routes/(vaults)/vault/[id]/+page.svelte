<script lang="ts">
	import type { PageData } from './$types';
	import VaultView from './VaultView.svelte';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Matter / {data.folderName}</title></svelte:head>

<!-- SvelteKit reuses this component across `[id]` changes, so key the live vault on its
     path: a new key tears down the old VaultView (its watcher disposes) and mounts a
     fresh one for the new folder. open() dedups by path, so each id maps to a unique
     path, making key-on-path equivalent to key-on-id. -->
{#key data.path}
	<VaultView path={data.path} />
{/key}
