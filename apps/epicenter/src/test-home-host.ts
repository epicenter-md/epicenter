import { join } from 'node:path';
import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { createHomeHost, type HomeHost, type HomeHostInputs } from './host.ts';
import type { ConversationsWorkspace } from './workspace.ts';
import { conversationsWorkspace } from './workspace.ts';
import { createEpicenterWorkspaceOwner } from './workspace-owner.ts';

type OwnedTestHomeHostOptions = HomeHostInputs & {
	/** Fixture root only. Production has no separate Home data directory. */
	dataDir: string;
	workspacesRoot?: string;
	wrapConversations?: (
		workspace: ConversationsWorkspace,
	) => ConversationsWorkspace;
};

/** Test composition for the production rule that one owner opens Honeycrisp. */
export async function createOwnedTestHomeHost(
	options: OwnedTestHomeHostOptions,
): Promise<HomeHost> {
	const { host, workspaceOwner } = await createOwnedTestHomeHostBundle(options);
	return Object.freeze({
		...host,
		async [Symbol.asyncDispose]() {
			await host[Symbol.asyncDispose]();
			await workspaceOwner[Symbol.asyncDispose]();
		},
	});
}

export async function createOwnedTestHomeHostBundle(
	options: OwnedTestHomeHostOptions,
) {
	const { dataDir, workspacesRoot, wrapConversations, ...hostOptions } =
		options;
	const workspaceOwner = createEpicenterWorkspaceOwner(
		workspacesRoot ?? join(dataDir, 'workspaces'),
	);
	try {
		const [honeycrisp, conversations] = await Promise.all([
			workspaceOwner.open(honeycrispWorkspace),
			workspaceOwner.open(conversationsWorkspace),
		]);
		const host = await createHomeHost({
			...hostOptions,
			honeycrisp,
			conversations: wrapConversations?.(conversations) ?? conversations,
		});
		return { host, workspaceOwner };
	} catch (cause) {
		await workspaceOwner[Symbol.asyncDispose]();
		throw cause;
	}
}
