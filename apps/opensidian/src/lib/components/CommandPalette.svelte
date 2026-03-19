<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import {
		CommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import { getFileIcon } from '$lib/fs/file-icons';
	import { fsState } from '$lib/fs/fs-state.svelte';

	let open = $state(false);
	let searchQuery = $state('');
	let debouncedQuery = $state('');

	// ── Collect all files recursively (only when palette is open) ────
	type FileEntry = { id: FileId; name: string; parentDir: string };

	const allFiles = $derived.by((): FileEntry[] => {
		if (!open) return [];
		void fsState.version;

		const files: FileEntry[] = [];
		function collect(parentId: FileId | null) {
			for (const childId of fsState.getChildIds(parentId)) {
				const row = fsState.getRow(childId);
				if (!row) continue;
				if (row.type === 'file') {
					const fullPath = fsState.getPathForId(childId) ?? '';
					const lastSlash = fullPath.lastIndexOf('/');
					const parentDir = lastSlash > 0 ? fullPath.slice(1, lastSlash) : '';
					files.push({ id: childId, name: row.name, parentDir });
				} else if (row.type === 'folder') {
					collect(childId);
				}
			}
		}
		collect(null);
		return files;
	});

	// ── Debounce search input at 150ms ───────────────────────────────
	$effect(() => {
		const query = searchQuery;
		const timer = setTimeout(() => {
			debouncedQuery = query;
		}, 150);
		return () => clearTimeout(timer);
	});

	// ── Reset search when palette closes ─────────────────────────────
	$effect(() => {
		if (!open) {
			searchQuery = '';
			debouncedQuery = '';
		}
	});

	// ── Filtered results: startsWith first, then includes, cap 50 ───
	const filteredFiles = $derived.by(() => {
		const q = debouncedQuery.toLowerCase().trim();
		if (!q) return allFiles.slice(0, 50);

		const startsWith: FileEntry[] = [];
		const includes: FileEntry[] = [];

		for (const file of allFiles) {
			const name = file.name.toLowerCase();
			if (name.startsWith(q)) {
				startsWith.push(file);
			} else if (name.includes(q)) {
				includes.push(file);
			}
			if (startsWith.length + includes.length >= 50) break;
		}

		return [...startsWith, ...includes].slice(0, 50);
	});

	// ── Convert filtered files to palette items ─────────────────────
	const fileItems = $derived<CommandPaletteItem[]>(
		filteredFiles.map((file) => ({
			id: file.id,
			label: file.name,
			description: file.parentDir || undefined,
			icon: getFileIcon(file.name),
			group: 'Files',
			onSelect: () => fsState.actions.selectFile(file.id),
		})),
	);
</script>

<svelte:window
	onkeydown={(e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			open = !open;
		}
	}}
/>

<CommandPalette
	items={fileItems}
	bind:open
	bind:value={searchQuery}
	shouldFilter={false}
	placeholder="Search files..."
	emptyMessage="No files found."
	title="Search Files"
	description="Search for a file by name"
/>
