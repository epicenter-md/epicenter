<script lang="ts">
	import { cn } from '../utils.js';
	import type { TreeViewRootProps } from './types';

	let { children, class: className, ...rest }: TreeViewRootProps = $props();
</script>

<div role="tree" class={cn('flex flex-col gap-0.5', className)} {...rest}>
	{@render children?.()}
</div>
