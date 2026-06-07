<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { createDemoVault } from './demo-vault.svelte';

	// A browser-only harness for the grid: no Tauri, no folder watcher. Edits run the
	// real serialize transforms and re-classify, so this is a faithful preview of the
	// production pipeline, not a static mock. Open it with `bun run dev` at /demo.
	const vault = createDemoVault();
</script>

<svelte:head><title>Matter / demo</title></svelte:head>

<main class="flex h-screen flex-col">
	<div class="flex min-h-12 items-center gap-3 border-b px-4 py-2">
		<Badge variant="outline">demo</Badge>
		<Badge variant="id" class="max-w-[60vw] truncate">{vault.folderName}</Badge>
		<span class="text-xs text-muted-foreground">
			In-memory fixtures. Edits run the real transforms, nothing touches disk.
		</span>
	</div>

	<FolderGrid {vault} />
</main>
