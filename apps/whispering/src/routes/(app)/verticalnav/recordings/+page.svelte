<script lang="ts">
	import RecordingsPage from '../../(config)/recordings/+page.svelte';
	import { useSidebar } from '@repo/ui/sidebar';

	const sidebar = useSidebar();
</script>

<div class:hidden-header={sidebar.state === 'expanded' && !sidebar.isMobile}>
	<RecordingsPage />
</div>

<style>
	.hidden-header :global(h1) {
		display: none;
	}

	:global(h1) {
		padding-left: 1.375rem;
	}

	@media (min-width: 768px) {
		:global(h1) {
			padding-left: 0;
		}
	}
</style>
