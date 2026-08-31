<script lang="ts">
	/**
	 * Force-blur the focused element when the page is being hidden (tab close,
	 * Cmd+W, tab switch, window minimize, mobile app-switch, bfcache
	 * navigation). `.blur()` synchronously dispatches the blur event, so every
	 * commit-on-blur input handler runs and writes its store before the page
	 * is torn down.
	 *
	 * Render once in the root `+layout.svelte`, like `Toaster` or
	 * `ModeWatcher`. See ADR-0110 and
	 * docs/articles/commit-on-blur-survives-tab-close.md.
	 */
	function flushPendingEdits() {
		if (
			document.visibilityState === 'hidden' &&
			document.activeElement instanceof HTMLElement
		) {
			document.activeElement.blur();
		}
	}
</script>

<!--
	visibilitychange is a document event and pagehide is a window event (per
	Svelte's elements.d.ts); keep each on the right special element or it will
	typecheck loosely and never fire. Listen to both: visibilitychange is more
	reliable on iOS Safari, pagehide catches bfcache navigations.
-->
<svelte:document onvisibilitychange={flushPendingEdits} />
<svelte:window onpagehide={flushPendingEdits} />
