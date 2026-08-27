/**
 * The mirror: a workspace's files, kept current (ADR-0271).
 *
 * A follower composed on the opened data's public surface, one direction only.
 * It renders rows to files and sends them to whoever owns a filesystem; nothing
 * it writes is ever read back, so a file edited on disk is overwritten by the
 * next render and cannot reach the store. That refusal is what keeps receipts,
 * three-way merges, and a conflict concept out of this file, and it is the seam
 * to guard: the moment anything here reads a rendered file's CONTENTS,
 * ADR-0207's whole write direction starts growing back. Reading the folder's
 * NAMES is not that, and is how a deleted row's file goes away.
 *
 * ## Why it renders everything rather than what changed
 *
 * A per-row renderer is only as correct as its change signal is complete: every
 * way a row can change has to reach it, or one file is silently and permanently
 * wrong. That is an open-ended class of bug, and the store does not currently
 * offer a signal that complete (a document commit on a table declaring no
 * derivation reaches no subscriber). A whole render depends on no signal at
 * all: it reads what is there.
 *
 * This is the same conclusion the SQL projection reached before it was deleted,
 * in its own words: "the store's superseded built-in projection kept a second
 * per-row patch path beside the rebuild, and its own comments record why that
 * was a liability: two code paths that can disagree." A commit therefore does
 * not say what to write; it only says the folder is out of date.
 *
 * The cost is honest: every pass hydrates every row's document. That is fine
 * for hundreds of rows and too slow for hundreds of thousands, and a per-row
 * path earns its complexity on the day a vault is that big, with a complete
 * change signal as its stated price.
 */
import type { Logger } from 'wellcrafted/logger';

import type { DataDefinition } from '../definition/index.js';
import { renderArtifact, type RenderableData } from './render.js';
import {
	createMirrorSink,
	type MirrorSink,
	type MirrorWorkspace,
} from './webview.js';

/** How long the store has to stay quiet before a render runs. */
const IDLE_MS = 400;

/**
 * The slice of an opened store the mirror listens to.
 *
 * `onCommitted` and nothing else: it fires for anything committed into this
 * document, whoever authored it, and a whole render needs no more than that.
 */
export type MirrorableData = RenderableData & {
	readonly store: { onCommitted(listener: () => void): () => void };
};

/**
 * Render this workspace into its folder, and keep it there.
 *
 * Renders once on attach, because a workspace changes while an application is
 * closed: another device syncs, and the folder is stale until something renders
 * it whole. After that, a commit schedules a render and further commits push it
 * out, so a burst of typing costs one pass rather than one per keystroke.
 */
export function attachMirror({
	data,
	definition,
	workspace,
	sink = createMirrorSink({
		workspace,
		definitionId: definition.id,
		fetch: globalThis.fetch,
	}),
	log,
	idleMs = IDLE_MS,
}: {
	data: MirrorableData;
	/** The authored definition, whose codecs the render serializes through. */
	definition: DataDefinition;
	workspace: MirrorWorkspace;
	/** Injected so a test drives this without a host and without a network. */
	sink?: MirrorSink;
	log: Logger;
	idleMs?: number;
}): AsyncDisposable {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The one pass in flight, so two never write the same file at once. */
	let running: Promise<void> = Promise.resolve();
	/** What the last pass put there, so the next one can take away the rest. */
	let written: Set<string> | undefined;

	async function render(): Promise<void> {
		const produced = new Set<string>();
		for await (const rendered of renderArtifact(data, definition)) {
			if (stopped) return;
			if (rendered.error !== null) {
				// One row that cannot render does not cost the others their files.
				// The next pass tries it again, because a pass reads current state
				// rather than a queue of what is owed.
				log.error(rendered.error);
				continue;
			}
			const { path, contents } = rendered.data;
			if (contents === undefined) continue;
			const write = await sink.write(path, contents);
			if (write.error !== null) {
				log.error(write.error);
				continue;
			}
			produced.add(path);
		}
		if (stopped) return;

		// What the folder holds and this pass did not produce is a row that is
		// gone. On the first pass that set comes from the folder itself, because
		// a row deleted on another device while this one was closed left a file
		// nothing in memory remembers.
		const present = written ?? (await listFolder());
		for (const path of present) {
			if (produced.has(path) || stopped) continue;
			const removed = await sink.remove(path);
			if (removed.error !== null) {
				log.error(removed.error);
			}
		}
		written = produced;

		// The folder settled, so the index beside it can be rebuilt from it. Last,
		// and only after the sweep, so it never describes a file that is about to
		// be removed.
		const indexed = await sink.index();
		if (indexed.error !== null) log.error(indexed.error);
	}

	async function listFolder(): Promise<string[]> {
		const listed = await sink.list();
		if (listed.error === null) return listed.data;
		// A folder that cannot be listed leaves stale files behind, which is a
		// wrong folder rather than wrong data. Reported, and the render that
		// already wrote every current file stands.
		log.error(listed.error);
		return [];
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
