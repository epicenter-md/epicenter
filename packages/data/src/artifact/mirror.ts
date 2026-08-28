/**
 * The mirror: a workspace's files, kept current (ADR-0271).
 *
 * A follower composed on the opened data's public surface, one direction only.
 * It renders rows to files and sends them to whoever owns a filesystem;
 * nothing it writes is ever read back, so a file edited on disk is overwritten
 * by the next render and cannot reach the store. That refusal is what keeps
 * receipts, three-way merges, and a conflict concept out of this file, and it
 * is the seam to guard: the moment anything here reads a rendered file's
 * CONTENTS, ADR-0207's whole write direction starts growing back.
 *
 * ## It states, it does not ask
 *
 * A pass says what the workspace holds. It never asks what the folder
 * currently holds, because the folder is the host's and the diff is therefore
 * the host's. That single refusal deletes the listing call, the per-file
 * delete call, the index call, and the set this file used to keep of what the
 * last pass produced.
 *
 * What crosses is a manifest and the contents of the files in it:
 *
 * ```txt
 * {"path":"notes/abc.md","contents":"…"}
 * {"manifest":["kv.json","notes/abc.md"]}
 * ```
 *
 * A row whose render FAILED is in the manifest with no contents line, which is
 * how a file survives a render it could not produce. Under a "tell the host
 * what to delete" design that row's file was deleted, because it was absent
 * from the set of things produced; under a manifest, absence of contents means
 * "leave it alone" and only absence from the manifest means "it is gone."
 *
 * ## Why it renders everything rather than what changed
 *
 * A per-row renderer is only as correct as its change signal is complete, and
 * the store does not currently offer one that is: a row's rich document lives
 * in its own Yjs document (ADR-0248), so its commits produce no delta on the
 * application document's table root and reach no table subscriber. A whole
 * render depends on no signal at all: it reads what is there.
 *
 * The cost is honest: every pass hydrates every row's document, measured at
 * roughly 71 ms per thousand rows. Rendering only the rows a signal names
 * costs about 0.1 ms and needs the store to invalidate a row when its document
 * commits, on both the local and the remote-acceptance arm. That is the next
 * change, and the manifest is what makes it safe when it lands: a partial
 * content signal would cost one row's contents being stale, and could never
 * lose a deletion or miss a new row, because the manifest is enumerated from
 * current state and depends on no signal.
 */
import type { Logger } from 'wellcrafted/logger';

import type { DataDefinition } from '../definition/index.js';
import { rowPath } from './layout.js';
import {
	type RenderableData,
	type RenderError,
	renderArtifact,
} from './render.js';
import { type MirrorPlace, mirrorLine } from './protocol.js';
import { createMirrorSink, type MirrorSink } from './webview.js';

/** How long the store has to stay quiet before a pass runs. */
const IDLE_MS = 400;

/**
 * How much of a pass is buffered before it is sent.
 *
 * A ceiling rather than a tuning knob. WebKit has no streaming request body,
 * so something has to be buffered; this is how much, and it bounds the
 * application's memory at a size no personal vault makes interesting.
 */
const BATCH_BYTES = 1024 * 1024;

/**
 * The slice of an opened store the mirror listens to.
 *
 * `onCommitted` and nothing else: it fires for anything committed into this
 * document, whoever authored it, and a whole render needs no more than that.
 */
export type MirrorableData = RenderableData & {
	readonly store: { onCommitted(listener: () => void): () => void };
};

/** The file a render error was about, when it was about one. */
function failedPath(error: RenderError): string | undefined {
	return 'table' in error && 'rowId' in error
		? rowPath(error.table, error.rowId)
		: undefined;
}

/**
 * Render this workspace into its folder, and keep it there.
 *
 * Renders once on attach, because a workspace changes while an application is
 * closed: another device syncs, and the folder is stale until something
 * renders it whole. After that, a commit schedules a pass and further commits
 * push it out, so a burst of typing costs one pass rather than one per
 * keystroke.
 */
export function attachMirror({
	data,
	definition,
	place,
	sink = createMirrorSink({
		place,
		databaseId: definition.id,
		fetch: globalThis.fetch,
	}),
	log,
	idleMs = IDLE_MS,
	batchBytes = BATCH_BYTES,
}: {
	data: MirrorableData;
	/** The authored definition, whose codecs the render serializes through. */
	definition: DataDefinition;
	place: MirrorPlace;
	/** Injected so a test drives this without a host and without a network. */
	sink?: MirrorSink;
	log: Logger;
	idleMs?: number;
	batchBytes?: number;
}): AsyncDisposable {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The one pass in flight, so two never describe the folder at once. */
	let running: Promise<void> = Promise.resolve();

	async function render(): Promise<void> {
		const manifest: string[] = [];
		/**
		 * Whether this pass got to say what the workspace holds at all.
		 *
		 * A definition that will not compile enumerates nothing, so the manifest
		 * would be empty and the host would read that as "every file is gone."
		 * A pass that could not enumerate sends no manifest, which leaves the
		 * folder exactly as it was.
		 */
		let enumerated = true;
		let batch = '';

		/** Send what is buffered. Reported and dropped: the next pass re-renders. */
		async function flush(): Promise<void> {
			if (batch === '') return;
			const sent = batch;
			batch = '';
			const { error } = await sink.send(sent);
			if (error !== null) log.error(error);
		}

		for await (const rendered of renderArtifact(data, definition)) {
			if (stopped) return;
			if (rendered.error !== null) {
				// One row that cannot render does not cost the others their files,
				// and does not cost itself its own: its path still enters the
				// manifest, so the host leaves the file it already has. The next
				// pass tries again, because a pass reads current state rather than
				// a queue of what is owed.
				log.error(rendered.error);
				const path = failedPath(rendered.error);
				if (path === undefined) enumerated = false;
				else manifest.push(path);
				continue;
			}
			const { path, contents } = rendered.data;
			if (contents === undefined) continue;
			manifest.push(path);
			batch += mirrorLine({ path, contents });
			if (batch.length >= batchBytes) await flush();
			if (stopped) return;
		}
		if (stopped) return;

		// Last, and alone in carrying the manifest: it is what tells the host the
		// pass is complete, so a connection dropped mid-pass leaves files written
		// and nothing deleted. Stale beats deleted, and a pass that could not
		// enumerate says nothing rather than saying "nothing is left."
		if (enumerated) batch += mirrorLine({ manifest });
		await flush();
	}

	/** Queue a pass behind whatever is running, so passes never interleave. */
	function schedule(): void {
		running = running.then(() => (stopped ? undefined : render()));
	}

	schedule();

	const unsubscribe = data.store.onCommitted(() => {
		// A commit says the folder is out of date and nothing more. It does not
		// say which file, on purpose: that is the signal a whole render does not
		// need and cannot get wrong.
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(schedule, idleMs);
	});

	return {
		async [Symbol.asyncDispose]() {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			unsubscribe();
			// Awaited so a caller that disposes and then reads the folder sees a
			// pass that finished rather than one abandoned mid-write.
			await running;
		},
	};
}
