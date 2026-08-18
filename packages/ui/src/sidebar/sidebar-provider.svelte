<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';
	import {
		SIDEBAR_COOKIE_MAX_AGE,
		SIDEBAR_COOKIE_NAME,
		SIDEBAR_WIDTH,
		SIDEBAR_WIDTH_ICON,
	} from './constants.js';
	import { setSidebar } from './context.svelte.js';

	let {
		ref = $bindable(null),
		open = $bindable(true),
		onOpenChange = () => {},
		class: className,
		style,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	} = $props();

	const sidebar = setSidebar({
		open: () => open,
		setOpen: (value: boolean) => {
			open = value;
			onOpenChange(value);

			// This sets the cookie to keep the sidebar state.
			// biome-ignore lint/suspicious/noDocumentCookie: intentional cookie for sidebar persistence
			document.cookie = `${SIDEBAR_COOKIE_NAME}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
		},
	});
</script>

<svelte:window onkeydown={sidebar.handleShortcutKeydown} />

<!--
	No Tooltip.Provider here. This wrapper holds the whole app, not just the
	sidebar, so a provider here would set the hover delay for every tooltip on
	the page and shadow the app's own. The instant delay the collapsed rail
	wants belongs to the rail: see sidebar-menu-button.svelte.
	Apps supply a Tooltip.Provider at their root.
-->
<div
	data-slot="sidebar-wrapper"
	style="--sidebar-width: {SIDEBAR_WIDTH}; --sidebar-width-icon: {SIDEBAR_WIDTH_ICON}; {style}"
	class={cn(
		'group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full',
		className,
	)}
	bind:this={ref}
	{...restProps}
>
	{@render children?.()}
</div>
