/**
 * createDocuments() — runtime document manager factory.
 *
 * Creates a bidirectional link between a table and its associated content Y.Docs.
 * It:
 * 1. Manages Y.Doc creation and provider lifecycle for each content document
 * 2. Watches content documents → calls `onUpdate` callback and writes returned fields to the row
 * 3. Watches the table → automatically cleans up documents when rows are deleted
 *
 * Most users never call this directly — `createWorkspace()` wires it automatically
 * when tables have `.withDocument()` declarations. Advanced users can use it standalone.
 *
 * @example
 * ```typescript
 * import { createDocuments, createTables, defineTable } from '@epicenter/workspace';
 * import * as Y from 'yjs';
 * import { type } from 'arktype';
 *
 * const filesTable = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', {
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * const ydoc = new Y.Doc({ guid: 'my-workspace' });
 * const tables = createTables(ydoc, { files: filesTable });
 *
 * const contentDocuments = createDocuments({
 *   guidKey: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 *   tableHelper: tables.files,
 *   ydoc,
 * });
 *
 * const handle = await contentDocuments.open(someRow);
 * const text = handle.read();
 * handle.write('new content');
 * ```
 *
 * @module
 */

import * as Y from 'yjs';
import { createTimeline } from '../timeline/timeline.js';
import {
	defineExtension,
	destroyLifo,
	type Extension,
	type MaybePromise,
	startDestroyLifo,
} from './lifecycle.js';
import type {
	BaseRow,
	DocumentExtensionRegistration,
	DocumentHandle,
	Documents,
	TableHelper,
} from './types.js';

/**
 * Sentinel symbol used as the Y.js transaction origin when the documents manager
 * bumps `updatedAt` on a row. Consumers can check `transaction.origin === DOCUMENTS_ORIGIN`
 * to distinguish auto-bumps from user-initiated row changes.
 *
 * @example
 * ```typescript
 * import { DOCUMENTS_ORIGIN } from '@epicenter/workspace';
 *
 * client.tables.files.observe((changedIds, transaction) => {
 *   if (transaction.origin === DOCUMENTS_ORIGIN) {
 *     // This was an auto-bump from a content doc edit
 *     return;
 *   }
 *   // This was a direct row change
 * });
 * ```
 */
export const DOCUMENTS_ORIGIN = Symbol('documents');

/**
 * Internal entry for an open document.
 * Tracks the Y.Doc, resolved extensions (with required whenReady/destroy),
 * the updatedAt observer teardown, and the composite whenReady promise.
 */
type DocEntry = {
	ydoc: Y.Doc;
	// biome-ignore lint/suspicious/noExplicitAny: runtime storage uses wide type
	extensions: Record<string, Extension<any>>;
	unobserve: () => void;
	whenReady: Promise<DocumentHandle>;
};

/**
 * Configuration for `createDocuments()`.
 *
 * @typeParam TRow - The row type of the bound table
 */
export type CreateDocumentsConfig<TRow extends BaseRow> = {
	/** The workspace identifier. Passed through to `DocumentContext.id`. */
	id?: string;
	/** Column name storing the Y.Doc GUID. */
	guidKey: keyof TRow & string;
	/** Called when the content Y.Doc changes. Return the fields to write to the row. */
	onUpdate: () => Partial<Omit<TRow, 'id'>>;
	/** The table helper — needed to update the row and observe row deletions. */
	tableHelper: TableHelper<TRow>;
	/** The workspace Y.Doc — needed for transact() when bumping updatedAt. */
	ydoc: Y.Doc;
	/**
	 * Document extension registrations (from `withDocumentExtension()` calls).
	 * Each registration has a key, factory, and optional tags for filtering.
	 * At open time, registrations are filtered by tag matching before firing.
	 */
	documentExtensions?: DocumentExtensionRegistration[];
	/**
	 * Tags declared on this documents instance (from `withDocument(..., { tags })`).
	 * Used for tag matching against document extension registrations.
	 */
	documentTags?: readonly string[];
};

/**
 * Create a runtime documents manager — a bidirectional link between table rows
 * and their content Y.Docs.
 *
 * The manager handles:
 * - Y.Doc creation with `gc: false` (required for Yjs provider compatibility)
 * - Provider lifecycle (persistence, sync) via document extension hooks
 * - Automatic `updatedAt` bumping when content documents change
 * - Automatic cleanup when rows are deleted from the table
 *
 * @param config - Documents configuration
 * @returns A `Documents<TRow>` with open/close/closeAll/guidOf methods
 */
export function createDocuments<TRow extends BaseRow>(
	config: CreateDocumentsConfig<TRow>,
): Documents<TRow> {
	const {
		id = '',
		guidKey,
		onUpdate,
		tableHelper,
		ydoc: workspaceYdoc,
		documentExtensions = [],
		documentTags = [],
	} = config;

	const openDocuments = new Map<string, DocEntry>();

	/**
	 * Set up the table observer for row deletion cleanup.
	 * Closes the associated document when a row is deleted from the table.
	 *
	 * When guidKey is 'id' (common case), the document GUID is the row ID,
	 * so a direct Map lookup finds it. When guidKey is a different column,
	 * the row is already deleted so we can't reverse-map row ID → GUID.
	 * The fallback check (openDocuments.has(deletedId)) only catches the
	 * case where the GUID happens to equal the row ID.
	 */
	const unobserveTable = tableHelper.observe((changedIds) => {
		for (const deletedId of changedIds) {
			const result = tableHelper.get(deletedId);
			if (result.status !== 'not_found') continue;
			if (!openDocuments.has(deletedId)) continue;

			documents.close(deletedId);
		}
	});

	const documents: Documents<TRow> = {
		async open(input: TRow | string): Promise<DocumentHandle> {
			const guid = typeof input === 'string' ? input : String(input[guidKey]);

			const existing = openDocuments.get(guid);
			if (existing) return existing.whenReady;

			const contentYdoc = new Y.Doc({ guid, gc: false });
			const timeline = createTimeline(contentYdoc);

			// Filter document extensions by tag matching:
			// - No tags on extension → fire for all documents (universal)
			// - Has tags → fire only if document tags and extension tags share ANY value
			const applicableExtensions = documentExtensions.filter((reg) => {
				if (reg.tags.length === 0) return true;
				return reg.tags.some((tag) => documentTags.includes(tag));
			});

			// Call document extension factories synchronously.
			// IMPORTANT: No await between openDocuments.get() and openDocuments.set() — ensures
			// concurrent open() calls for the same guid are safe.
			// Build the extensions map incrementally so each factory sees prior
			// extensions' resolved form.
			// biome-ignore lint/suspicious/noExplicitAny: runtime storage uses wide type
			const resolvedExtensions: Record<string, Extension<any>> = {};
			const destroys: (() => MaybePromise<void>)[] = [];
			const whenReadyPromises: Promise<unknown>[] = [];

			try {
				for (const { key, factory } of applicableExtensions) {
					const ctx = {
						id,
						ydoc: contentYdoc,
						timeline,
						whenReady:
							whenReadyPromises.length === 0
								? Promise.resolve()
								: Promise.all(whenReadyPromises).then(() => {}),
						extensions: { ...resolvedExtensions },
					};
					const raw = factory(ctx);
					if (!raw) continue;

					const resolved = defineExtension(raw);
					resolvedExtensions[key] = resolved;
					destroys.push(resolved.destroy);
					whenReadyPromises.push(resolved.whenReady);
				}
			} catch (err) {
				startDestroyLifo(destroys);

				contentYdoc.destroy();
				throw err;
			}

			// Attach onUpdate observer — fires when content doc changes.
			// The Y.Doc 'update' handler receives (update, origin, doc, transaction).
			// We use transaction.local to skip remote sync updates — only local edits
			// should trigger the callback. Remote devices receive the updated values via
			// workspace ydoc sync; redundant writes would cause unnecessary churn.
			const updateHandler = (
				_update: Uint8Array,
				origin: unknown,
				_doc: Y.Doc,
				transaction: Y.Transaction,
			) => {
				// Skip updates from the documents manager itself to avoid loops
				if (origin === DOCUMENTS_ORIGIN) return;
				// Skip remote updates — only local edits trigger onUpdate
				if (!transaction.local) return;

				// Call the user's onUpdate callback and write the returned fields
				workspaceYdoc.transact(() => {
					tableHelper.update(guid, onUpdate());
				}, DOCUMENTS_ORIGIN);
			};

			contentYdoc.on('update', updateHandler);
			const unobserve = () => contentYdoc.off('update', updateHandler);

			// Cache entry SYNCHRONOUSLY before any promise resolution
			const compositeWhenReady: Promise<void> =
				whenReadyPromises.length === 0
					? Promise.resolve()
					: Promise.all(whenReadyPromises).then(() => {});
			const handle = Object.assign(timeline, {
				id,
				timeline,
				extensions: resolvedExtensions,
				whenReady: compositeWhenReady,
			}) as DocumentHandle;
			const whenReady =
				whenReadyPromises.length === 0
					? Promise.resolve(handle)
					: compositeWhenReady.then(() => handle)
							.catch(async (err) => {
							const errors = await destroyLifo(destroys);
							unobserve();
							contentYdoc.destroy();
							openDocuments.delete(guid);

							if (errors.length > 0) {
								console.error('Document extension cleanup errors:', errors);
							}
								throw err;
							});

			openDocuments.set(guid, {
				ydoc: contentYdoc,
				extensions: resolvedExtensions,
				unobserve,
				whenReady,
			});
			return whenReady;
		},

		async close(input: TRow | string): Promise<void> {
			const guid = typeof input === 'string' ? input : String(input[guidKey]);
			const entry = openDocuments.get(guid);
			if (!entry) return;

			// Remove from map SYNCHRONOUSLY so concurrent open() calls
			// create a fresh Y.Doc. Async cleanup follows.
			openDocuments.delete(guid);
			entry.unobserve();

			const errors = await destroyLifo(
				Object.values(entry.extensions).map((e) => e.destroy),
			);

			entry.ydoc.destroy();

			if (errors.length > 0) {
				throw new Error(`Document extension cleanup errors: ${errors.length}`);
			}
		},

		async closeAll(): Promise<void> {
			const entries = Array.from(openDocuments.entries());
			// Clear map synchronously first
			openDocuments.clear();
			unobserveTable();

			for (const [, entry] of entries) {
				entry.unobserve();

				const errors = await destroyLifo(
					Object.values(entry.extensions).map((e) => e.destroy),
				);

				entry.ydoc.destroy();

				if (errors.length > 0) {
					console.error('Document extension cleanup error:', errors);
				}
			}
		},
	};

	return documents;
}
