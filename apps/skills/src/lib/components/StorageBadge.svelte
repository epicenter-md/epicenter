<script lang="ts">
	import { Database } from '@lucide/svelte';
	import { createSubscriber } from 'svelte/reactivity';
	import type * as Y from 'yjs';
	import { encodeStateAsUpdate } from 'yjs';
	import { workspace } from '$lib/client';
	import { skillsState } from '$lib/state/skills-state.svelte';

	/**
	 * Create a reactive Y.Doc size observer.
	 *
	 * Uses `createSubscriber` to bridge Y.Doc's `update` event into Svelte's
	 * reactivity system. Reading `.bytes` inside a reactive context (template,
	 * `$derived`, `$effect`) re-evaluates whenever the document changes.
	 *
	 * Follows the canonical Svelte 5 `MediaQuery` getter pattern—`subscribe()`
	 * inside a getter links the reactive context to the external event source.
	 */
	function createYdocSize(ydoc: Y.Doc) {
		const subscribe = createSubscriber((update) => {
			ydoc.on('update', update);
			return () => ydoc.off('update', update);
		});

		return {
			get bytes() {
				subscribe();
				return encodeStateAsUpdate(ydoc).byteLength;
			},
		};
	}

	const skillCount = $derived(skillsState.skills.length);
	const storageSize = createYdocSize(workspace.ydoc);

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const units = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${parseFloat((bytes / k ** i).toFixed(1))} ${units[i]}`;
	}
</script>

<div
	class="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs text-muted-foreground"
>
	<Database class="size-3 shrink-0" />
	<span>
		{skillCount}
		{skillCount === 1 ? 'skill' : 'skills'}
		<span class="text-muted-foreground/60">·</span>
		{formatBytes(storageSize.bytes)}
	</span>
</div>
