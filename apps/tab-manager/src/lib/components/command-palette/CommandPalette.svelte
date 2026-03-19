<script lang="ts">
	import { CommandPalette } from '@epicenter/ui/command-palette';
	import { items } from './items';

	let { open = $bindable(false) }: { open: boolean } = $props();
</script>

<CommandPalette {items} bind:open />
