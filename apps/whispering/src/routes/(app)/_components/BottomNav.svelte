<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import { page } from '$app/state';
	import { NAV_ITEMS } from './nav-items';
</script>

<!-- Keep mobile app chrome below Dialog/Drawer z-40 and AlertDialog z-50. -->
<nav
	class="bg-sidebar border-sidebar-border fixed inset-x-0 bottom-0 z-30 flex h-14 items-center gap-1 border-t px-1"
>
	{#each NAV_ITEMS as item}
		{@const active = item.isActive(page.url.pathname)}
		{@const Icon = item.icon}
		<a
			href={item.href}
			class={cn(
				'flex flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring active:bg-sidebar-accent active:text-sidebar-accent-foreground',
				active
					? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
					: 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
			)}
		>
			<Icon class="size-5" />
			<span class="w-full truncate text-center">{item.label}</span>
		</a>
	{/each}
</nav>
