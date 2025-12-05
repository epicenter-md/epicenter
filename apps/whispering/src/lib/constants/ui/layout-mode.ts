/**
 * Layout modes for the application navigation.
 *
 * - `sidebar`: Uses the collapsible vertical sidebar for navigation.
 *   Nav items show on home page but hidden on config pages.
 * - `nav-items`: Uses inline navigation items in the header.
 *   No sidebar, nav items visible on all pages.
 */
export const LAYOUT_MODES = ['sidebar', 'nav-items'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const LAYOUT_MODE_OPTIONS = [
	{
		value: 'sidebar' as const,
		label: 'Sidebar Navigation',
		description: 'Use the collapsible sidebar on the left. Best for desktop with a larger screen.',
	},
	{
		value: 'nav-items' as const,
		label: 'Header Navigation',
		description: 'Use navigation items in the header bar. Cleaner look, works well on smaller screens.',
	},
] satisfies { value: LayoutMode; label: string; description: string }[];
