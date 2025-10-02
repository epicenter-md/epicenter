<script lang="ts">
	import { cn } from '#/utils/utils.js';
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';

	let {
		class: className,
		ref = $bindable(null),
		...restProps
	}: AlertDialogPrimitive.OverlayProps = $props();
</script>

<AlertDialogPrimitive.Overlay
	bind:ref
	data-slot="alert-dialog-overlay"
	class={cn(
		'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50',
		// Override to z-[110] to ensure alert-dialogs appear above regular dialogs (z-[100])
		'z-[110]',
		className,
	)}
	{...restProps}
/>
