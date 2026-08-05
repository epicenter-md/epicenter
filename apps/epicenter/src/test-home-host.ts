import { join } from 'node:path';
import { createDesktopEpicenterOwner } from '@epicenter/data/desktop-owner';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createFolderBridge } from './folder/bridge.ts';
import { openReceiptStore } from './folder/receipts.ts';
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
	const { host, dataOwner, folderReceipts } =
		await createOwnedTestHomeHostBundle(options);
	return Object.freeze({
		...host,
		async [Symbol.asyncDispose]() {
			await host[Symbol.asyncDispose]();
			folderReceipts.close();
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
	// The folder is not optional in production (ADR-0207 has no flag), so a test
	// host composes a real one under the fixture root rather than a stub.
	const folderReceipts = openReceiptStore(
		join(dataDir, 'folder-receipts.sqlite3'),
	);
	try {
		const conversations = dataOwner.epicenter.bind(homeLens);
		const honeycrisp = dataOwner.epicenter.bind(honeycrispMirrorLens);
		const folderBridge = createFolderBridge({
			source: dataOwner,
			lenses: [honeycrispMirrorLens, homeLens],
		});
		const host = await createHomeHost({
			...hostOptions,
			honeycrisp,
			conversations: wrapConversations?.(conversations) ?? conversations,
			folder: {
				root: join(dataDir, 'Epicenter'),
				receipts: folderReceipts,
				lookup: folderBridge.lookup,
				writer: folderBridge.writer,
			},
		});
		return { host, dataOwner, folderReceipts };
	} catch (cause) {
		folderReceipts.close();
		await dataOwner[Symbol.asyncDispose]();
		throw cause;
	}
}
