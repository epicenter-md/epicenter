import { join } from 'node:path';
import { createDesktopEpicenterOwner } from '@epicenter/data/desktop-owner';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createHomeHost, type HomeHost, type HomeHostInputs } from './host.ts';
import type { ConversationsData } from './workspace.ts';
import { homeLens, honeycrispMirrorLens } from './workspace.ts';

type OwnedTestHomeHostOptions = HomeHostInputs & {
	/** Fixture root only. Production has no separate Home data directory. */
	dataDir: string;
	workspacesRoot?: string;
	wrapConversations?: (workspace: ConversationsData) => ConversationsData;
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
	const { host, dataOwner } = await createOwnedTestHomeHostBundle(options);
	return Object.freeze({
		...host,
		async [Symbol.asyncDispose]() {
			await host[Symbol.asyncDispose]();
			await dataOwner[Symbol.asyncDispose]();
		},
	});
}

export async function createOwnedTestHomeHostBundle(
	options: OwnedTestHomeHostOptions,
) {
	const { dataDir, workspacesRoot, wrapConversations, ...hostOptions } =
		options;
	const dataOwner = await createDesktopEpicenterOwner({
		directory: workspacesRoot ?? join(dataDir, 'data'),
	});
	try {
		const conversations = dataOwner.epicenter.bind(homeLens).tables;
		const honeycrisp = dataOwner.epicenter.bind(honeycrispMirrorLens).tables;
		const host = await createHomeHost({
			...hostOptions,
			honeycrisp,
			conversations: wrapConversations?.(conversations) ?? conversations,
		});
		return { host, dataOwner };
	} catch (cause) {
		await dataOwner[Symbol.asyncDispose]();
		throw cause;
	}
}
