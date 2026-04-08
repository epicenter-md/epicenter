<script lang="ts">
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';

	let {
		defaultValue = '',
		icon = 'file',
		onConfirm,
		onCancel,
	}: {
		defaultValue?: string;
		icon?: 'file' | 'folder';
		onConfirm: (name: string) => void;
		onCancel: () => void;
	} = $props();

	let value = $derived(defaultValue);
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
	 * Idempotency guard — prevents double-fire when Enter keydown and
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
	{#if icon === 'folder'}
		<FolderIcon
			aria-hidden="true"
			class="h-4 w-4 shrink-0 text-muted-foreground"
		/>
	{:else}
		<FileIcon
			aria-hidden="true"
			class="h-4 w-4 shrink-0 text-muted-foreground"
		/>
	{/if}
	<input
		bind:this={inputEl}
		bind:value
		aria-label={defaultValue ? `Rename ${icon}` : `New ${icon} name`}
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
			// Defer to next frame so transient focus shifts settle. Without
			// this, context menu close restores focus to the trigger element,
			// which blurs the input and cancels it before the user can type.
			// Works together with onCloseAutoFocus in FileTreeItem.
			requestAnimationFrame(() => {
				if (inputEl && document.activeElement !== inputEl) {
					confirm();
				}
			});
		}}
	>
</div>
