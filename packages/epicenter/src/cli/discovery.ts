import { stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import type { ActionContracts } from '../core/actions';
import type { ProjectDir } from '../core/types';
import type { BoundWorkspaceClient } from '../core/workspace/contract';

type AnyWorkspaceClient = BoundWorkspaceClient<string, ActionContracts>;

export async function findProjectDir(
	startDir: string = process.cwd(),
): Promise<ProjectDir | null> {
	let current = resolve(startDir);
	const root = parse(current).root;

	while (current !== root) {
		const configPath = join(current, 'epicenter.config.ts');

		if (await fileExists(configPath)) {
			return current as ProjectDir;
		}

		current = dirname(current);
	}

	return null;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		const stats = await stat(path);
		return stats.isFile();
	} catch {
		return false;
	}
}

export async function loadClients(
	projectDir: ProjectDir,
): Promise<AnyWorkspaceClient[]> {
	const configPath = join(projectDir, 'epicenter.config.ts');

	if (!(await fileExists(configPath))) {
		throw new Error(
			`No epicenter.config.ts found at ${configPath}\n` +
				`Create a config file that exports an array of workspace clients.`,
		);
	}

	const module = await import(configPath);
	const clients = module.default;

	if (!Array.isArray(clients)) {
		throw new Error(
			`epicenter.config.ts must export an array of workspace clients as default export.`,
		);
	}

	if (clients.length === 0) {
		throw new Error(`epicenter.config.ts exported an empty array of clients.`);
	}

	for (const client of clients) {
		if (!isWorkspaceClient(client)) {
			throw new Error(
				`Invalid client in epicenter.config.ts. Expected BoundWorkspaceClient with id and contracts properties.`,
			);
		}
	}

	return clients;
}

function isWorkspaceClient(value: unknown): value is AnyWorkspaceClient {
	return (
		typeof value === 'object' &&
		value !== null &&
		'id' in value &&
		'contracts' in value &&
		typeof (value as Record<string, unknown>).id === 'string'
	);
}
