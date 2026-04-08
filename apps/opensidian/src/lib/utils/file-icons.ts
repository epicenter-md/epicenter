/**
 * Extension → Lucide icon mapping for file type awareness.
 *
 * Used by FileTreeItem (tree view icons) and CommandPalette (search results).
 * Returns the Lucide component to render for a given filename.
 *
 * @example
 * ```svelte
 * {@const Icon = getFileIcon('readme.md')}
 * <Icon class="h-4 w-4" />
 * ```
 */

import FileIcon from '@lucide/svelte/icons/file';
import FileCode from '@lucide/svelte/icons/file-code';
import FileJson from '@lucide/svelte/icons/file-json';
import FileText from '@lucide/svelte/icons/file-text';

const EXTENSION_ICONS: Record<string, typeof FileIcon> = {
	'.md': FileText,
	'.txt': FileText,
	'.ts': FileCode,
	'.js': FileCode,
	'.tsx': FileCode,
	'.jsx': FileCode,
	'.json': FileJson,
};

export function getFileIcon(name: string): typeof FileIcon {
	const dotIndex = name.lastIndexOf('.');
	if (dotIndex === -1) return FileIcon;
	const ext = name.slice(dotIndex).toLowerCase();
	return EXTENSION_ICONS[ext] ?? FileIcon;
}
