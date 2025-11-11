<script lang="ts">
	import { Separator } from "#/separator/index.js";
	import { cn } from "#/utils/utils.js";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: ComponentProps<typeof Separator> = $props();
</script>

<Separator
	bind:ref
	data-slot="sidebar-separator"
	data-sidebar="separator"
	class={cn("bg-sidebar-border", className)}
	{...restProps}
/>
