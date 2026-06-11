<script lang="ts">
	import '../app.css';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';

	let { children } = $props();

	/**
	 * Force-fire onblur on the currently-focused element when the page is
	 * being hidden. This catches the "user typed in a field, hits Cmd+W"
	 * case: `.blur()` synchronously dispatches the blur event, so any
	 * commit-on-blur handler runs and updates the Y.Doc before the page is
	 * destroyed. See docs/articles/commit-on-blur-survives-tab-close.md.
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
	Tab-close safety net: when the page is being hidden (Cmd+W, tab switch,
	window minimize, mobile app-switch, bfcache), force-blur the focused
	element so any input wired to commit on `onblur` gets its handler fired
	synchronously, updating the Y.Doc before the page is torn down.
	Listening to both visibilitychange (document) and pagehide (window) for
	cross-browser coverage: visibilitychange is more reliable on iOS Safari,
	pagehide catches bfcache navigations. Per Svelte's elements.d.ts,
	pagehide is a window event, visibilitychange is a document event.
-->
<svelte:document onvisibilitychange={flushPendingEdits} />
<svelte:window onpagehide={flushPendingEdits} />

<ConfirmationDialog />
<Toaster />
<ModeWatcher />
{@render children()}
