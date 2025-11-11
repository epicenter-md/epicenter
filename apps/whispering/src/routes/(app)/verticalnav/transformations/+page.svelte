<script lang="ts">
	import TransformationsPage from '../../(config)/transformations/+page.svelte';
</script>

<TransformationsPage />

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
