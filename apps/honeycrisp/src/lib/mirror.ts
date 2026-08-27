/**
 * Honeycrisp's mirror: every commit becomes files in `~/Epicenter` (ADR-0271).
 *
 * A follower, composed on the opened data's public surface, and one direction
 * only. It renders rows to files and sends them to the host; nothing it writes
 * is ever read back, so a file edited on disk is overwritten by the next render
 * and cannot reach the store. That refusal is what deletes receipts, three-way
 * merges, and a conflict concept from this file, and it is the seam to guard:
 * the moment anything here reads a rendered file, ADR-0207's whole write
 * direction starts growing back.
 *
 * Attached for the lifetime of an open store, beside sync, and disposed with
 * it. Nothing here is durable: the store already persisted the commit, so a
 * file that failed to write is re-rendered by the next commit or the next boot.
 */

import { renderArtifact, renderRow } from '@epicenter/data/artifact';
import {
	createMirrorSink,
	type MirrorWorkspace,
} from '@epicenter/data/artifact/webview';
import type { DataOf, DataStoreBase } from '@epicenter/data';
import { parseData } from '@epicenter/data/definition';
import { reportBackgroundError } from './report.js';
import { honeycrispDefinition } from './workspace/index.js';

/** An opened Honeycrisp workspace, either kind: the mirror reads both alike. */
type OpenedHoneycrisp = DataOf<typeof honeycrispDefinition, DataStoreBase>;

/**
 * Render this workspace into the folder, and keep it there.
 *
 * The boot pass exists because a workspace changes while the application is
 * closed: another device syncs, and the folder is stale until something renders
 * it whole. After that, only the rows a commit touched are re-rendered.
 */
export function attachMirror({
	data,
	workspace,
	fetch,
}: {
	data: OpenedHoneycrisp;
	workspace: MirrorWorkspace;
	fetch?: typeof globalThis.fetch;
}): Disposable {
	const parsed = parseData(honeycrispDefinition);
	if (parsed.error !== null) {
		// A definition that will not compile is a programmer error, and the app is
		// already running on it. The mirror declines rather than taking the app
		// down over a folder.
		reportBackgroundError(parsed.error);
		return { [Symbol.dispose]() {} };
	}
	const definition = parsed.data;
	const sink = createMirrorSink({
		workspace,
		definitionId: definition.id,
		fetch,
	});

	let stopped = false;

	/** One row's file, written or unlinked. Never throws at a subscriber. */
	async function renderOne(table: string, rowId: string): Promise<void> {
		const rendered = await renderRow(data, definition, table, rowId);
		if (stopped) return;
		if (rendered.error !== null) {
			reportBackgroundError(rendered.error);
			return;
		}
		const { path, contents } = rendered.data;
		const written =
			contents === undefined
				? await sink.remove(path)
				: await sink.write(path, contents);
		if (written.error !== null) reportBackgroundError(written.error);
	}

	void (async () => {
		for await (const rendered of renderArtifact(data, honeycrispDefinition)) {
			if (stopped) return;
			if (rendered.error !== null) {
				reportBackgroundError(rendered.error);
				continue;
			}
			const { path, contents } = rendered.data;
			if (contents === undefined) continue;
			const written = await sink.write(path, contents);
			if (written.error !== null) reportBackgroundError(written.error);
		}
	})();

	const unsubscribes = [...definition.tables.keys()].map((table) =>
		data.tables[table as keyof typeof data.tables].subscribe((invalidation) => {
			if (invalidation.scope === 'rows') {
				// The ids a commit touched include the ones it removed, so one call
				// answers write-this and unlink-that without a second signal.
				for (const rowId of invalidation.rowIds) void renderOne(table, rowId);
				return;
			}
			// Nothing emits this arm today (ADR-0187 keeps it for a future
			// out-of-process carrier). Rendering the table whole is the honest
			// answer to "something in here changed and I cannot say what."
			for (const rowId of data.stored().tables.get(table)?.keys() ?? []) {
				void renderOne(table, rowId);
			}
		}),
	);

	return {
		[Symbol.dispose]() {
			stopped = true;
			for (const unsubscribe of unsubscribes) unsubscribe();
		},
	};
}
