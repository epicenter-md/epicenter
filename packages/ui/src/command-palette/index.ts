import type { Component } from 'svelte';

export { default as CommandPalette } from './command-palette.svelte';

/**
 * A single item that can appear in the command palette.
 *
 * This is the shared contract between command sources (workspace actions,
 * static registries, dynamic search results) and the `CommandPalette` component.
 * Anything that produces this shape can feed the palette—no adapters, no wrappers.
 *
 * Only `id`, `label`, and `onSelect` are required. Every other field is a
 * progressive enhancement—omit what you don't need and the component adapts:
 * no icon → text-only row, no description → single-line label, no keywords →
 * search matches against the label alone.
 *
 * @example
 * ```typescript
 * const items: CommandPaletteItem[] = [
 *   {
 *     id: 'dedup',
 *     label: 'Remove Duplicates',
 *     description: 'Close duplicate tabs with the same URL',
 *     icon: CopyMinusIcon,
 *     keywords: ['dedup', 'duplicate', 'clean'],
 *     group: 'Quick Actions',
 *     destructive: true,
 *     onSelect: () => removeDuplicates(),
 *   },
 * ];
 * ```
 */
export type CommandPaletteItem = {
	/** Stable identifier used as the Svelte `{#each}` key. Must be unique within the items array. */
	id: string;
	/** Primary display text shown for this command. Also used as the base search target. */
	label: string;
	/**
	 * Secondary text rendered below the label in a smaller, muted style.
	 *
	 * When the item is `destructive`, this doubles as the confirmation dialog
	 * description (falls back to "Are you sure?" when omitted).
	 */
	description?: string;
	/**
	 * Svelte component rendered as a 16×16 icon to the left of the label.
	 *
	 * Typically a Lucide icon import. Omit when icons aren't available
	 * (e.g. programmatically generated items).
	 */
	icon?: Component;
	/**
	 * Extra search tokens beyond the label. The palette builds its search
	 * value as `[label, ...keywords].join(' ')`, so these let users find
	 * the command via synonyms or abbreviations without cluttering the label.
	 *
	 * @example `['dedup', 'duplicate', 'clean']`
	 */
	keywords?: string[];
	/**
	 * Heading under which this item is grouped in the palette.
	 *
	 * Items sharing the same `group` string are rendered together under a
	 * `Command.Group` heading. Items without a group render ungrouped at
	 * the top.
	 */
	group?: string;
	/**
	 * When `true`, selecting this item opens a confirmation dialog before
	 * executing `onSelect`. The dialog uses `label` as its title and
	 * `description` as its body text.
	 *
	 * Use for irreversible or high-impact operations (bulk close, delete, etc.).
	 * Defaults to `false` when omitted.
	 */
	destructive?: boolean;
	/** Callback invoked when the user selects this item (after confirmation if `destructive`). */
	onSelect: () => void | Promise<void>;
};
