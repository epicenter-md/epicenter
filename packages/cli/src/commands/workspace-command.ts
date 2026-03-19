import type { Dirent, Stats } from 'node:fs';
import {
	lstat,
	mkdir,
	readdir,
	readlink,
	rm,
	symlink,
	unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { $ } from 'bun';
import type { AbsolutePath } from 'jsrepo';
import {
	DEFAULT_PROVIDERS,
	parseWantedItems,
	resolveAndFetchAllItems,
	resolveRegistries,
	resolveWantedItems,
} from 'jsrepo';
import type { Argv, CommandModule } from 'yargs';
import type { DiscoveredWorkspace } from '../discovery';
import { loadClientFromPath } from '../discovery';
import { formatYargsOptions, output, outputError } from '../format-output';
import { workspacesDir } from '../paths';

/**
 * Build the `workspace` command group with subcommands for managing local workspaces.
 * @param home - Epicenter home directory path.
 * @returns A yargs CommandModule for the `workspace` command.
 */
export function buildWorkspaceCommand(home: string): CommandModule {
	return {
		command: 'workspace <subcommand>',
		describe: 'Manage local workspaces',
		builder: (y: Argv) =>
			y
				.command(buildWorkspaceAddCommand(home))
				.command(buildWorkspaceInstallCommand(home))
				.command(buildWorkspaceUninstallCommand(home))
				.command(buildWorkspaceLsCommand(home))
				.command(buildWorkspaceExportCommand(home))
				.demandCommand(1, 'You must specify a workspace subcommand'),
		handler: () => {},
	};
}

// workspace add <path>
function buildWorkspaceAddCommand(home: string) {
	return {
		command: 'add <path>',
		describe: 'Symlink a local workspace into Epicenter',
		builder: (y: Argv) =>
			y.positional('path', {
				type: 'string' as const,
				demandOption: true,
				describe: 'Path to a directory containing epicenter.config.ts',
			}),
		handler: async (argv: { path: string }) => {
			const targetPath = resolve(argv.path);
			const configPath = join(targetPath, 'epicenter.config.ts');

			if (!(await Bun.file(configPath).exists())) {
				outputError(`No epicenter.config.ts found at ${targetPath}`);
				process.exitCode = 1;
				return;
			}

			const client = await loadClientFromPath(configPath);
			const workspaceId = client.id;
			const linkPath = join(workspacesDir(home), workspaceId);

			try {
				await lstat(linkPath);
				outputError(`Workspace "${workspaceId}" already exists at ${linkPath}`);
				process.exitCode = 1;
				return;
			} catch {
				// doesn't exist — good
			}

			await mkdir(workspacesDir(home), { recursive: true });
			await symlink(targetPath, linkPath);
			output({ added: workspaceId, path: targetPath, link: linkPath });
		},
	};
}

// workspace install <items..>
function buildWorkspaceInstallCommand(home: string) {
	return {
		command: 'install <item>',
		describe: 'Install a workspace from a jsrepo registry',
		builder: (y: Argv) =>
			y
				.positional('item', {
					type: 'string' as const,
					demandOption: true,
					describe:
						'Registry item to install (e.g. github/myorg/workspaces/my-app)',
				})
				.option('registry', {
					type: 'string' as const,
					describe: 'Registry URL (e.g. github/myorg/workspaces)',
				}),
		handler: async (argv: { item: string; registry?: string }) => {
			const itemArg = argv.item;

			// Parse the item spec — if it includes a registry prefix, extract it
			// jsrepo items can be: "github/org/repo/item" or just "item" with --registry
			const registryUrl = argv.registry ?? extractRegistry(itemArg);
			const itemName = argv.registry ? itemArg : extractItemName(itemArg);

			if (!registryUrl) {
				outputError(
					'Could not determine registry. Use --registry or provide a full path like github/myorg/workspaces/my-app',
				);
				process.exitCode = 1;
				return;
			}

			console.log(`Resolving ${itemName} from ${registryUrl}...`);

			const cwd = process.cwd() as AbsolutePath;

			// 1. Resolve registry
			const registriesResult = await resolveRegistries([registryUrl], {
				cwd,
				providers: DEFAULT_PROVIDERS,
			});
			if (registriesResult.isErr()) {
				outputError(`Failed to resolve registry: ${registriesResult.error}`);
				process.exitCode = 1;
				return;
			}

			// 2. Parse wanted items
			const parsed = parseWantedItems([itemName], {
				providers: DEFAULT_PROVIDERS,
				registries: [registryUrl],
			});
			if (parsed.isErr()) {
				outputError(`Failed to parse item: ${parsed.error}`);
				process.exitCode = 1;
				return;
			}

			// 3. Resolve wanted items against registry manifest
			const resolved = await resolveWantedItems(parsed.value.wantedItems, {
				resolvedRegistries: registriesResult.value,
				nonInteractive: true,
			});
			if (resolved.isErr()) {
				outputError(`Failed to resolve item: ${resolved.error}`);
				process.exitCode = 1;
				return;
			}

			// 4. Fetch file contents
			const items = await resolveAndFetchAllItems(resolved.value);
			if (items.isErr()) {
				outputError(`Failed to fetch item: ${items.error}`);
				process.exitCode = 1;
				return;
			}

			if (items.value.length === 0) {
				outputError('No items found');
				process.exitCode = 1;
				return;
			}

			const item = items.value[0];
			if (!item) {
				outputError('No items found');
				process.exitCode = 1;
				return;
			}
			const wsDir = join(workspacesDir(home), item.name);

			// Check for existing
			if (await Bun.file(join(wsDir, 'epicenter.config.ts')).exists()) {
				outputError(
					`Workspace "${item.name}" already exists at ${wsDir}. Use "epicenter update" to update it.`,
				);
				process.exitCode = 1;
				return;
			}

			await mkdir(wsDir, { recursive: true });
			await mkdir(join(wsDir, 'data'), { recursive: true });

			// 5. Write files
			for (const file of item.files) {
				const filePath = join(wsDir, file.path);
				await mkdir(dirname(filePath), { recursive: true });
				await Bun.write(filePath, file.content);
			}

			console.log(`Wrote ${item.files.length} file(s)`);

			// 6. Generate package.json from dependencies
			const deps: Record<string, string> = {};
			for (const dep of item.dependencies ?? []) {
				if (typeof dep === 'string') {
					deps[dep] = 'latest';
				} else {
					deps[dep.name] = dep.version ?? 'latest';
				}
			}

			if (Object.keys(deps).length > 0) {
				const pkg = { name: item.name, private: true, dependencies: deps };
				await Bun.write(
					join(wsDir, 'package.json'),
					JSON.stringify(pkg, null, 2),
				);
				console.log('Installing dependencies...');
				await $`bun install`.cwd(wsDir).quiet();
			}

			// 7. Write manifest.json with provenance
			const manifest = {
				registry: registryUrl,
				item: item.name,
				installedAt: new Date().toISOString(),
				files: item.files.map((f: { path: string }) => f.path),
			};
			await Bun.write(
				join(wsDir, 'manifest.json'),
				JSON.stringify(manifest, null, 2),
			);

			output({
				installed: item.name,
				path: wsDir,
				files: item.files.length,
				dependencies: Object.keys(deps).length,
			});
		},
	};
}

// workspace uninstall <id>
function buildWorkspaceUninstallCommand(home: string) {
	return {
		command: 'uninstall <workspace-id>',
		describe: 'Remove a workspace (delete directory or unlink symlink)',
		builder: (y: Argv) =>
			y.positional('workspace-id', {
				type: 'string' as const,
				demandOption: true,
				describe: 'Workspace ID to remove',
			}),
		handler: async (argv: { 'workspace-id': string }) => {
			const wsId = argv['workspace-id'];
			const wsPath = join(workspacesDir(home), wsId);

			let stat: Stats;
			try {
				stat = await lstat(wsPath);
			} catch {
				outputError(`Workspace "${wsId}" not found at ${wsPath}`);
				process.exitCode = 1;
				return;
			}

			if (stat.isSymbolicLink()) {
				await unlink(wsPath);
				output({ removed: wsId, type: 'unlinked' });
			} else {
				await rm(wsPath, { recursive: true, force: true });
				output({ removed: wsId, type: 'deleted' });
			}
		},
	};
}

// workspace ls
function buildWorkspaceLsCommand(home: string) {
	return {
		command: 'ls',
		describe: 'List installed workspaces',
		builder: (y: Argv) => y.options(formatYargsOptions()),
		handler: async (argv: { format?: 'json' | 'jsonl' }) => {
			const dir = workspacesDir(home);

			let dirents: Dirent[];
			try {
				dirents = await readdir(dir, { withFileTypes: true });
			} catch {
				output([], { format: argv.format });
				return;
			}

			const workspaces: DiscoveredWorkspace[] = [];

			for (const dirent of dirents) {
				const fullPath = join(dir, dirent.name);
				const isSymlink = dirent.isSymbolicLink();
				const configExists = await Bun.file(
					join(fullPath, 'epicenter.config.ts'),
				).exists();
				const hasManifest = await Bun.file(
					join(fullPath, 'manifest.json'),
				).exists();

				const resolvedPath = isSymlink
					? await readlink(fullPath).catch(() => fullPath)
					: fullPath;

				const entry: DiscoveredWorkspace & { registry?: string | null } = {
					id: dirent.name,
					type: isSymlink ? 'linked' : 'installed',
					path: resolvedPath,
					status: configExists ? 'ok' : 'error',
				};

				if (!configExists) {
					entry.error = isSymlink
						? 'symlink target not found or missing config'
						: 'missing epicenter.config.ts';
				}

				if (hasManifest) {
					try {
						const manifest = JSON.parse(
							await Bun.file(join(fullPath, 'manifest.json')).text(),
						);
						(entry as Record<string, unknown>).registry =
							manifest.registry ?? null;
					} catch {
						// ignore corrupt manifest
					}
				}

				workspaces.push(entry);
			}

			output(workspaces, { format: argv.format });
		},
	};
}

// workspace export <id>
function buildWorkspaceExportCommand(home: string) {
	return {
		command: 'export <workspace-id>',
		describe: 'Export workspace data as JSON',
		builder: (y: Argv) =>
			y
				.positional('workspace-id', {
					type: 'string' as const,
					demandOption: true,
					describe: 'Workspace ID to export',
				})
				.option('table', {
					type: 'string' as const,
					describe: 'Export only a specific table',
				})
				.options(formatYargsOptions()),
		handler: async (argv: {
			'workspace-id': string;
			table?: string;
			format?: 'json' | 'jsonl';
		}) => {
			const wsId = argv['workspace-id'];
			const wsPath = join(workspacesDir(home), wsId);
			const configPath = join(wsPath, 'epicenter.config.ts');

			if (!(await Bun.file(configPath).exists())) {
				outputError(`Workspace "${wsId}" not found at ${wsPath}`);
				process.exitCode = 1;
				return;
			}

			// Load the Y.Doc from disk if it exists
			const dataPath = join(wsPath, 'data', 'workspace.yjs');
			const client = await loadClientFromPath(configPath);

			if (await Bun.file(dataPath).exists()) {
				const data = await Bun.file(dataPath).arrayBuffer();
				client.loadSnapshot(new Uint8Array(data));
			}

			const result: Record<string, unknown[]> = {};
			const tableNames = argv.table
				? [argv.table]
				: Object.keys(client.definitions.tables);

			for (const tableName of tableNames) {
				const table = client.tables[tableName];
				if (!table) {
					outputError(`Table "${tableName}" not found in workspace "${wsId}"`);
					process.exitCode = 1;
					return;
				}
				result[tableName] = table.getAllValid();
			}

			output(result, { format: argv.format });
		},
	};
}

/** Extract registry URL from a full item path like "github/org/repo/item" */
function extractRegistry(itemPath: string): string | undefined {
	// jsrepo format: "provider/org/repo/category/item" or "provider/org/repo/item"
	const parts = itemPath.split('/');
	if (parts.length >= 4) {
		// provider/org/repo is the registry
		return parts.slice(0, 3).join('/');
	}
	return undefined;
}

/** Extract item name from a full item path */
function extractItemName(itemPath: string): string {
	const parts = itemPath.split('/');
	if (parts.length >= 4) {
		// Everything after provider/org/repo is the item spec
		return parts.slice(3).join('/');
	}
	return itemPath;
}
