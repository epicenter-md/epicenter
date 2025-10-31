<script lang="ts">
	import DesktopAppPage from '../../(config)/desktop-app/+page.svelte';
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

<DesktopAppPage />
