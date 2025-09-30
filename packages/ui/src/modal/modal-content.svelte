<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import type { DialogContentProps } from 'bits-ui';

	import * as Dialog from '#/dialog/index.js';
	import * as Drawer from '#/drawer/index.js';

	import { useModalSub } from './modal-state.svelte.js';

	const modal = useModalSub();

	let {
		children,
		hideClose = false,
		ref = $bindable(null),
		...rest
	}: DialogContentProps & { hideClose?: boolean } = $props();
</script>

{#if modal.view === 'desktop'}
	<Dialog.Content bind:ref {...rest} {hideClose}>
		{@render children?.()}
	</Dialog.Content>
{:else}
	<Drawer.Content bind:ref {...rest}>
		{@render children?.()}
	</Drawer.Content>
{/if}
