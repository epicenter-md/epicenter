<script lang="ts">
	import * as ResizablePrimitive from 'paneforge';
	import { cn } from '#/utils/utils.js';

	let {
		ref = $bindable(null),
		this: paneGroup = $bindable(),
		class: className,
		...restProps
	}: ResizablePrimitive.PaneGroupProps & {
		this?: ResizablePrimitive.PaneGroup;
	} = $props();
</script>

<ResizablePrimitive.PaneGroup
	bind:this={paneGroup}
	data-slot="resizable-pane-group"
	class={cn(
		'flex h-full w-full data-[direction=vertical]:flex-col',
		// Custom: Add spacing between resizable panes for visual separation
		'gap-2',
		className,
	)}
	{...restProps}
/>
