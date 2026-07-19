import { join } from 'node:path';
import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createHomeHost, type HomeHost, type HomeHostInputs } from './host.ts';
import type { ConversationsWorkspace } from './workspace.ts';
import { conversationsWorkspace } from './workspace.ts';
import {
	BUILT_IN_WORKSPACE_IDS,
	createEpicenterWorkspaceOwner,
} from './workspace-owner.ts';

type OwnedTestHomeHostOptions = HomeHostInputs & {
	/** Fixture root only. Production has no separate Home data directory. */
	dataDir: string;
	workspacesRoot?: string;
	wrapConversations?: (
		workspace: ConversationsWorkspace,
	) => ConversationsWorkspace;
};

/** A signed-out desktop authority over a no-op native port, for server tests. */
export function createTestDesktopAuth() {
	const callbackListeners = new Set<(url: string) => void>();
	return createDesktopAuthAuthority({
		authCell: null,
		nativeAuthPort: {
			completed: new Promise(() => undefined),
			async storeAuth() {},
			async openAuthUrl() {},
			relaunch() {},
			onOAuthCallback(listener) {
				callbackListeners.add(listener);
				return () => callbackListeners.delete(listener);
			},
		},
	});
}

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
		BUILT_IN_WORKSPACE_IDS,
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
