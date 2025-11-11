<script lang="ts">
	import RecordingsPage from '../../(config)/recordings/+page.svelte';
</script>

<RecordingsPage />

<style>
	:global(h1) {
		padding-left: 1.375rem;
	}

	@media (min-width: 768px) {
		:global(h1) {
			padding-left: 0;
		}
	}
</style>
