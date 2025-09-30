<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	import * as Dialog from '#/dialog/index.js';
	import * as Drawer from '#/drawer/index.js';

	import { useModalSub } from './modal-state.svelte.js';

	const modal = useModalSub();

	let {
		children,
		ref = $bindable(null),
		...rest
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

{#if modal.view === 'desktop'}
	<Dialog.Header bind:ref {...rest}>
		{@render children?.()}
	</Dialog.Header>
{:else}
	<Drawer.Header bind:ref {...rest}>
		{@render children?.()}
	</Drawer.Header>
{/if}
