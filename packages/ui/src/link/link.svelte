<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import { cn } from '#/utils/utils';
	import type { HTMLAnchorAttributes } from 'svelte/elements';

	let { children, class: className, ...rest }: HTMLAnchorAttributes = $props();
</script>

<a
	{...rest}
	class={cn(
		'text-foreground font-medium underline underline-offset-4',
		className,
	)}
>
	{@render children?.()}
</a>
