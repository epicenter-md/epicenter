<script lang="ts">
	import { untrack } from 'svelte';

	let {
		defaultValue = '',
		onConfirm,
		onCancel,
	}: {
		defaultValue?: string;
		onConfirm: (name: string) => void;
		onCancel: () => void;
	} = $props();

	let value = $state(untrack(() => defaultValue));
	let inputEl = $state<HTMLInputElement | null>(null);

	/**
	 * Select just the filename stem (before the last dot) on mount,
	 * so typing immediately replaces the name but keeps the extension.
	 * If no extension, selects all.
	 */
	$effect(() => {
		if (!inputEl) return;
		inputEl.focus();
		const dotIndex = defaultValue.lastIndexOf('.');
		if (dotIndex > 0) {
			inputEl.setSelectionRange(0, dotIndex);
		} else {
			inputEl.select();
		}
	});

	/**
	 * Idempotency guard. Prevents double-fire when Enter keydown and
	 * blur both call confirm().
	 */
	let confirmed = false;
	function confirm() {
		if (confirmed) return;
		confirmed = true;
		if (value.trim()) {
			onConfirm(value.trim());
		} else {
			onCancel();
		}
	}
</script>

<div class="flex items-center gap-1 px-2 py-0.5">
	<input
		bind:this={inputEl}
		bind:value
		aria-label={defaultValue ? `Rename ${defaultValue}` : 'New skill name'}
		class="h-6 w-full rounded-sm border border-ring bg-background px-1 text-sm outline-none"
		onkeydown={(e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				confirm();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				onCancel();
			}
			e.stopPropagation();
		}}
		onblur={() => {
			// requestAnimationFrame does not run while the document is hidden.
			// Start the async rename immediately so the runtime can admit it.
			if (document.visibilityState === 'hidden') {
				confirm();
				return;
			}
			requestAnimationFrame(() => {
				if (inputEl && document.activeElement !== inputEl) {
					confirm();
				}
			});
		}}
	>
</div>
