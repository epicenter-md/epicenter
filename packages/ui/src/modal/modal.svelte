<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import type { DialogRootProps } from 'bits-ui';

	import * as Dialog from '#/dialog/index.js';
	import * as Drawer from '#/drawer/index.js';

	import { useModal } from './modal-state.svelte.js';

	let {
		children,
		open = $bindable(false),
		...rest
	}: DialogRootProps = $props();

	const modal = useModal();
</script>

{#if modal.view === 'desktop'}
	<Dialog.Root bind:open {...rest}>
		{@render children?.()}
	</Dialog.Root>
{:else}
	<Drawer.Root bind:open {...rest}>
		{@render children?.()}
	</Drawer.Root>
{/if}
