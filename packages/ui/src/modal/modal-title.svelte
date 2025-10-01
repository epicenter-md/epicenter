<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import type { DialogTitleProps } from 'bits-ui';

	import * as Dialog from '#/dialog/index.js';
	import * as Drawer from '#/drawer/index.js';

	import { useModalSub } from './modal-state.svelte.js';

	const modal = useModalSub();

	let { ref = $bindable(null), ...rest }: DialogTitleProps = $props();
</script>

{#if modal.view === 'desktop'}
	<Dialog.Title bind:ref {...rest} />
{:else}
	<Drawer.Title bind:ref {...rest} />
{/if}
