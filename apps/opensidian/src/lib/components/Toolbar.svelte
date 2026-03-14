<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Separator } from '@epicenter/ui/separator';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { toast } from 'svelte-sonner';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import CreateDialog from './CreateDialog.svelte';
	import DeleteConfirmation from './DeleteConfirmation.svelte';
	import RenameDialog from './RenameDialog.svelte';

	let createDialogOpen = $state(false);
	let createDialogMode = $state<'file' | 'folder'>('file');
	let deleteDialogOpen = $state(false);
	let renameDialogOpen = $state(false);

	function openCreateFile() {
		createDialogMode = 'file';
		createDialogOpen = true;
	}

	function openCreateFolder() {
		createDialogMode = 'folder';
		createDialogOpen = true;
	}

	function openRename() {
		if (!fsState.activeFileId) return;
		renameDialogOpen = true;
	}

	function openDelete() {
		if (!fsState.activeFileId) return;
		deleteDialogOpen = true;
	}

	let seeding = $state(false);

	async function loadSampleData() {
		seeding = true;
		try {
			const { fs } = fsState;
			await fs.mkdir('/docs');
			await fs.mkdir('/src');
			await fs.mkdir('/src/utils');
			await fs.writeFile(
				'/README.md',
				'# FS Explorer\n\nA demo app for the Epicenter filesystem package.\n',
			);
			await fs.writeFile(
				'/docs/api.md',
				'# API Reference\n\n## YjsFileSystem\n\nThe main filesystem class.\n\n### Methods\n\n- `writeFile(path, content)` — Create or overwrite a file\n- `mkdir(path)` — Create a directory\n- `rm(path, opts)` — Remove a file or directory\n- `mv(from, to)` — Move or rename\n',
			);
			await fs.writeFile(
				'/docs/guide.md',
				'# Getting Started\n\n## Installation\n\n```bash\nbun add @epicenter/filesystem\n```\n\n## Quick Start\n\nCreate a workspace and filesystem instance, then use familiar path-based APIs.\n',
			);
			await fs.writeFile(
				'/src/index.ts',
				'import { YjsFileSystem } from "@epicenter/filesystem";\n\nexport function createApp() {\n  console.log("FS Explorer initialized");\n}\n',
			);
			await fs.writeFile(
				'/src/utils/helpers.ts',
				'/** Format a file size in bytes to a human-readable string. */\nexport function formatBytes(bytes: number): string {\n  if (bytes === 0) return "0 B";\n  const k = 1024;\n  const sizes = ["B", "KB", "MB", "GB"];\n  const i = Math.floor(Math.log(bytes) / Math.log(k));\n  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;\n}\n',
			);
			toast.success('Loaded sample data');
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : 'Failed to load sample data',
			);
			console.error(err);
		} finally {
			seeding = false;
		}
	}
</script>

<Tooltip.Provider>
	<div class="flex items-center gap-1 border-b px-2 py-1.5">
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" onclick={openCreateFile}>
						New File
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Create a new file</Tooltip.Content>
		</Tooltip.Root>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" onclick={openCreateFolder}>
						New Folder
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Create a new folder</Tooltip.Content>
		</Tooltip.Root>
		<Separator orientation="vertical" class="mx-1 h-4" />
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						onclick={openRename}
						disabled={!fsState.activeFileId}
					>
						Rename
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Rename selected item</Tooltip.Content>
		</Tooltip.Root>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						onclick={openDelete}
						disabled={!fsState.activeFileId}
					>
						Delete
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>Delete selected item</Tooltip.Content>
		</Tooltip.Root>
		<div class="ml-auto">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="outline"
							size="sm"
							onclick={loadSampleData}
							disabled={seeding}
						>
							{seeding ? 'Loading…' : 'Load Sample Data'}
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Load example files and folders</Tooltip.Content>
			</Tooltip.Root>
		</div>
	</div>
</Tooltip.Provider>

<CreateDialog bind:open={createDialogOpen} mode={createDialogMode} />
<RenameDialog bind:open={renameDialogOpen} />
<DeleteConfirmation bind:open={deleteDialogOpen} />
