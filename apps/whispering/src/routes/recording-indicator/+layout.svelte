<script lang="ts">
	/**
	 * Minimal layout for the recording indicator overlay.
	 * This overrides the root layout to avoid loading unnecessary components
	 * (QueryClient, Toaster, DevTools, etc.) in the small overlay window.
	 */
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

<div class="recording-indicator-layout">
	{@render children()}
</div>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: transparent !important;
		overflow: hidden;
		height: 100%;
	}

	.recording-indicator-layout {
		height: 100%;
		width: 100%;
	}
</style>
