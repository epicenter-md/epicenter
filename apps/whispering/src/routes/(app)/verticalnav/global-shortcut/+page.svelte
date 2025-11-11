<script lang="ts">
	import GlobalShortcutPage from '../../(config)/global-shortcut/+page.svelte';
	import { useSidebar } from '@repo/ui/sidebar';
	import { onMount } from 'svelte';

	const sidebar = useSidebar();

	// Collapse sidebar on mount for focused utility page experience
	onMount(() => {
		if (sidebar.state === 'expanded') {
			sidebar.setOpen(false);
		}
	});
</script>

<GlobalShortcutPage />
