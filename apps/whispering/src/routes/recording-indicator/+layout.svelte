<script lang="ts">
	/**
	 * Minimal layout for the recording indicator overlay.
	 * This overrides the root layout to avoid loading unnecessary components
	 * (QueryClient, Toaster, DevTools, etc.) in the small overlay window.
	 *
	 * NOTE: We intentionally do NOT import app.css here because it sets
	 * bg-background on body, which creates a visible rectangle behind
	 * the transparent rounded indicator.
	 */
	let { children } = $props();
</script>

{@render children()}

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: transparent !important;
		background-color: transparent !important;
		overflow: hidden;
		height: 100%;
	}
</style>
