import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachYjsFileSystem,
	createFileContentDoc,
	createSqliteIndex,
	type FileId,
	fileContentDocGuid,
} from '@epicenter/filesystem';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	composeSyncControls,
	createBrowserDocCache,
	createRemoteClient,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import { Bash } from 'just-bash';
import { clearDocument } from 'y-indexeddb';
import { createOpensidianActions } from './actions';
import { openOpensidian as openOpensidianDoc } from './index';

export function openOpensidian({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const doc = openOpensidianDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const fileContentDocs = createBrowserDocCache(
		{
			ids() {
				return doc.tables.files.getAllValid().map((file) => file.id);
			},
			create(fileId: FileId) {
				const contentDoc = createFileContentDoc({
					fileId,
					workspaceId: doc.ydoc.guid,
					filesTable: doc.tables.files,
					attachPersistence: attachIndexedDb,
				});
				return {
					...contentDoc,
					persistence: contentDoc.persistence as ReturnType<
						typeof attachIndexedDb
					>,
					sync: null,
				};
			},
			clearLocalData(fileId: FileId) {
				return clearDocument(
					fileContentDocGuid({
						workspaceId: doc.ydoc.guid,
						fileId,
					}),
				);
			},
		},
		{ gcTime: 5_000 },
	);
	const fileContent = {
		async read(fileId: FileId) {
			await using handle = fileContentDocs.open(fileId);
			await handle.whenReady;
			return handle.content.read();
		},
		async write(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.whenReady;
			handle.content.write(text);
		},
		async append(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.whenReady;
			handle.content.appendText(text);
			return handle.content.read();
		},
	};
	const sqliteIndex = createSqliteIndex({
		readContent: fileContent.read,
	})({
		tables: doc.tables,
	}).exports;
	const fs = attachYjsFileSystem(doc.tables.files, fileContent);
	const bash = new Bash({ fs, cwd: '/' });
	const actions = createOpensidianActions({ fs, sqliteIndex, bash });

	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		getToken: async () => {
			await auth.whenLoaded;

			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
		awareness,
	});
	const rpc = sync.attachRpc(actions);
	const remote = createRemoteClient({ awareness, rpc });

	return {
		...doc,
		idb,
		fileContentDocs,
		sqliteIndex,
		fs,
		bash,
		actions,
		awareness,
		sync,
		syncControl: composeSyncControls(sync, fileContentDocs.syncControl),
		async clearLocalData() {
			await fileContentDocs.clearLocalData();
			await idb.clearLocal();
		},
		remote,
		rpc,
		whenLoaded: idb.whenLoaded,
		[Symbol.dispose]() {
			fileContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
