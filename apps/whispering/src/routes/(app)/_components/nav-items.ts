import HomeIcon from '@lucide/svelte/icons/house';
import LayersIcon from '@lucide/svelte/icons/layers';
import ListIcon from '@lucide/svelte/icons/list';
import SettingsIcon from '@lucide/svelte/icons/settings';
import type { Component } from 'svelte';
import { WHISPERING_BASE_PATHNAME, whisperingPath } from '$lib/constants/urls';

export type NavItem = {
	label: string;
	href: string;
	icon: Component;
	isActive: (pathname: string) => boolean;
};

/** Matches a route and all its sub-routes (e.g., `/settings` matches `/settings/audio`). */
const matchesRoute = (href: string) => (pathname: string) =>
	pathname === href || pathname.startsWith(`${href}/`);

/**
 * Primary navigation items shared across sidebar and bottom bar layouts.
 *
 * Add new top-level routes here: both `VerticalNav` and `BottomNav` consume
 * this array, so changes propagate automatically.
 */
export const NAV_ITEMS = [
	{
		label: 'Home',
		href: whisperingPath('/'),
		icon: HomeIcon,
		isActive: (pathname) =>
			pathname === WHISPERING_BASE_PATHNAME || pathname === whisperingPath('/'),
	},
	{
		label: 'Recordings',
		href: whisperingPath('/recordings'),
		icon: ListIcon,
		isActive: matchesRoute(whisperingPath('/recordings')),
	},
	{
		label: 'Recipes',
		href: whisperingPath('/recipes'),
		icon: LayersIcon,
		isActive: matchesRoute(whisperingPath('/recipes')),
	},
	{
		label: 'Settings',
		href: whisperingPath('/settings'),
		icon: SettingsIcon,
		isActive: matchesRoute(whisperingPath('/settings')),
	},
] as const satisfies readonly NavItem[];
