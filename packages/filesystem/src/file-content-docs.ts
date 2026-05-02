/**
 * Per-file content Y.Doc builder. Pure: takes a `fileId` plus all the deps
 * the construction needs and returns a Disposable bundle. The builder owns
 * Y.Doc construction + timeline attachment + `updatedAt` writeback;
 * persistence is caller-owned via the `attachPersistence` callback:
 *
 *   // browser
 *   attachPersistence: (ydoc) => attachIndexedDb(ydoc),
 *
 *   // desktop / CLI: caller closes over a directory
 *   attachPersistence: (ydoc) => attachSqlite(ydoc, {
 *     filePath: join(contentDir, `${ydoc.guid}.db`),
 *   }),
 *
 *   // omit for in-memory (tests, Node stubs)
 *
 * The callback's return value is threaded: `whenLoaded` surfaces on
 * `whenReady`, `whenDisposed` is available on the persistence handle for
 * teardown barriers.
 *
 * The live document is browser-agnostic on purpose: it has no `sync`
 * field. Browser apps add `sync: null` inline when adapting it to
 * `createBrowserDocCache`; non-browser callers (daemon, CLI, e2e scripts)
 * compose this directly with `createDisposableCache`.
 */

import type { Table } from '@epicenter/workspace';
import {
	attachTimeline,
	type DocPersistence,
	docGuid,
	onLocalUpdate,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { FileId } from './ids.js';
import type { FileRow } from './table.js';

export function fileContentDocGuid({
	workspaceId,
	fileId,
}: {
	workspaceId: string;
	fileId: FileId;
}): string {
	return docGuid({
		workspaceId,
		collection: 'files',
		rowId: fileId,
		field: 'content',
	});
}

export function createFileContentDoc({
	fileId,
	workspaceId,
	filesTable,
	attachPersistence,
}: {
	fileId: FileId;
	workspaceId: string;
	filesTable: Table<FileRow>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}) {
	const ydoc = new Y.Doc({
		guid: fileContentDocGuid({ workspaceId, fileId }),
		gc: false,
	});
	onLocalUpdate(ydoc, () =>
		filesTable.update(fileId, { updatedAt: Date.now() }),
	);
	const persistence = attachPersistence?.(ydoc);
	return {
		ydoc,
		content: attachTimeline(ydoc),
		persistence,
		whenReady: persistence?.whenLoaded ?? Promise.resolve(),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
