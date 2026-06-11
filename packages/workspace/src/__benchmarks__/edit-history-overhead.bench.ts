/**
 * Edit History Overhead Benchmarks
 *
 * Answers: "How much bigger is a doc that was edited incrementally
 * compared to one created with the final state from scratch?"
 *
 * Compares two storage paths:
 * - Table rows (YKeyValueLww): each set() replaces the entire row as
 *   a single LWW entry. Old entries are GC'd but may leave residue.
 * - Document content (Y.Text via timeline): character-level CRDT where
 *   every keystroke is a separate operation. History accumulates per-char.
 *
 * Each test group builds two Y.Docs with identical final state: one through
 * incremental edits, one through a single pristine write. Then it compares
 * binary sizes. The delta is the "edit history tax."
 */

import { describe, test } from 'bun:test';
import * as Y from 'yjs';
import { createTables } from '../__tests__/create-tables.js';
import { attachTimeline } from '../index.js';
import {
	formatBytes,
	generateHeavyContent,
	heavyNoteDefinition,
	measureTime,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Group 1: Table Row Edits (LWW Replacement)
// ═══════════════════════════════════════════════════════════════════════════════

describe('table row edit overhead (LWW)', () => {
	/**
	 * Simulates metadata-style edits: title renames, tag changes, summary rewrites.
	 * Each set() replaces the entire row. The question is how much residue
	 * accumulates from N full-row replacements vs a single write.
	 */
	for (const editsPerRow of [10, 100, 500]) {
		test(`50 notes × ${editsPerRow} edits each vs pristine final state`, () => {
			const rowCount = 50;
			const contentChars = 5_000;
			const baseContent = generateHeavyContent(contentChars);

			// ── Incremental: create rows, then edit each one N times ────────
			const incrDoc = new Y.Doc();
			const incrTables = createTables(incrDoc, {
				notes: heavyNoteDefinition,
			});

			const { durationMs: incrWriteMs } = measureTime(() => {
				for (let i = 0; i < rowCount; i++) {
					// Initial creation
					incrTables.notes.set({
						id: `note-${i}`,
						title: `Note ${i}`,
						content: baseContent,
						summary: 'Initial summary',
						tags: ['draft'],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
				}

				// Progressive edits: title renames, summary rewrites, tag changes
				for (let edit = 1; edit <= editsPerRow; edit++) {
					for (let i = 0; i < rowCount; i++) {
						incrTables.notes.set({
							id: `note-${i}`,
							title: `Note ${i}: revision ${edit}`,
							content:
								baseContent.slice(0, contentChars - 20) + ` [edit ${edit}]`,
							summary: `Summary after edit ${edit}`,
							tags: edit % 5 === 0 ? ['draft', 'reviewed'] : ['draft'],
							createdAt: Date.now(),
							updatedAt: Date.now(),
						});
					}
				}
			});

			const incrSize = Y.encodeStateAsUpdate(incrDoc).byteLength;

			// ── Pristine: create rows once with the final state ─────────────
			const pristineDoc = new Y.Doc();
			const pristineTables = createTables(pristineDoc, {
				notes: heavyNoteDefinition,
			});

			const { durationMs: pristineWriteMs } = measureTime(() => {
				for (let i = 0; i < rowCount; i++) {
					pristineTables.notes.set({
						id: `note-${i}`,
						title: `Note ${i}: revision ${editsPerRow}`,
						content:
							baseContent.slice(0, contentChars - 20) +
							` [edit ${editsPerRow}]`,
						summary: `Summary after edit ${editsPerRow}`,
						tags: editsPerRow % 5 === 0 ? ['draft', 'reviewed'] : ['draft'],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
				}
			});

			const pristineSize = Y.encodeStateAsUpdate(pristineDoc).byteLength;

			const overhead = incrSize - pristineSize;
			const ratio = incrSize / pristineSize;

			console.log(`\n=== TABLE LWW: 50 notes × ${editsPerRow} edits ===`);
			console.log(
				`  Incremental: ${formatBytes(incrSize)} (${incrWriteMs.toFixed(0)}ms)`,
			);
			console.log(
				`  Pristine:    ${formatBytes(pristineSize)} (${pristineWriteMs.toFixed(0)}ms)`,
			);
			console.log(
				`  Overhead:    +${formatBytes(overhead)} (${ratio.toFixed(2)}x pristine)`,
			);
			console.log(
				`  Total ops:   ${(rowCount * (editsPerRow + 1)).toLocaleString()} set() calls`,
			);

			incrDoc.destroy();
			pristineDoc.destroy();
		});
	}
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 2: Document Content Edits (Y.Text Character-Level)
// ═══════════════════════════════════════════════════════════════════════════════

describe('document content edit overhead (Y.Text)', () => {
	/**
	 * Simulates typing a note through the timeline API.
	 *
	 * Incremental: text grows in sentence-sized chunks with occasional
	 * backspace-and-retype, mimicking how humans actually write.
	 *
	 * Pristine: the same final text written once via timeline.write().
	 */
	test('progressive typing: 5KB note built sentence by sentence', () => {
		// Build realistic sentences that accumulate into ~5KB
		const sentences = [
			'Meeting started at 10am with the full team present. ',
			'We reviewed the Q4 roadmap and identified three key priorities. ',
			'First, we need to ship the sync engine rewrite before end of month. ',
			'The current implementation has a race condition under heavy load. ',
			'Second, the onboarding flow needs a complete redesign. ',
			'User testing showed a 40% drop-off at the workspace creation step. ',
			'Third, we should invest in better error messages across the board. ',
			'Support tickets are dominated by cryptic error screens. ',
			'Action items were assigned and we set a two-week check-in cadence. ',
			'The team agreed to daily standups during the sprint. ',
			'Budget allocation was discussed briefly but deferred to next week. ',
			'We also touched on the hiring pipeline for the frontend role. ',
			'Three candidates are in the final round of interviews. ',
			'The meeting wrapped up at 11:15am with clear next steps. ',
			'Follow-up notes will be shared in the team channel by EOD. ',
		];

		// Repeat sentences to reach ~5KB
		const fullSentences: string[] = [];
		let totalLength = 0;
		const targetLength = 5_000;
		let sentenceIdx = 0;
		while (totalLength < targetLength) {
			const s = sentences[sentenceIdx % sentences.length]!;
			fullSentences.push(s);
			totalLength += s.length;
			sentenceIdx++;
		}
		const finalText = fullSentences.join('');

		// ── Incremental: type sentence by sentence with occasional rewrites ─
		const incrDoc = new Y.Doc();
		const incrTimeline = attachTimeline(incrDoc);

		const { durationMs: incrMs } = measureTime(() => {
			const ytext = incrTimeline.asText();

			let cursor = 0;
			for (let i = 0; i < fullSentences.length; i++) {
				const sentence = fullSentences[i]!;
				ytext.insert(cursor, sentence);
				cursor += sentence.length;

				// Every 5th sentence: simulate backspace-and-retype of the last word
				// (delete ~8 chars, retype them: like fixing a typo)
				if (i > 0 && i % 5 === 0) {
					const deleteLen = Math.min(8, cursor);
					const deleted = ytext.toString().slice(cursor - deleteLen, cursor);
					ytext.delete(cursor - deleteLen, deleteLen);
					cursor -= deleteLen;
					ytext.insert(cursor, deleted);
					cursor += deleted.length;
				}
			}
		});

		const incrSize = Y.encodeStateAsUpdate(incrDoc).byteLength;

		// ── Pristine: write the final text in one shot ──────────────────────
		const pristineDoc = new Y.Doc();
		const pristineTimeline = attachTimeline(pristineDoc);

		const { durationMs: pristineMs } = measureTime(() => {
			pristineTimeline.write(finalText);
		});

		const pristineSize = Y.encodeStateAsUpdate(pristineDoc).byteLength;

		const overhead = incrSize - pristineSize;
		const ratio = incrSize / pristineSize;

		console.log('\n=== Y.TEXT: Progressive typing ~5KB note ===');
		console.log(`  Final text length: ${finalText.length} chars`);
		console.log(`  Sentences typed:   ${fullSentences.length}`);
		console.log(
			`  Incremental: ${formatBytes(incrSize)} (${incrMs.toFixed(1)}ms)`,
		);
		console.log(
			`  Pristine:    ${formatBytes(pristineSize)} (${pristineMs.toFixed(1)}ms)`,
		);
		console.log(
			`  Overhead:    +${formatBytes(overhead)} (${ratio.toFixed(2)}x pristine)`,
		);

		incrDoc.destroy();
		pristineDoc.destroy();
	});

	/**
	 * Simulates heavy editing of an existing document: the user rewrites
	 * sections, moves paragraphs around (delete + reinsert), and makes
	 * many small fixes. Content stays ~10KB but churns heavily.
	 */
	test('heavy revision: 10KB note with 200 edit passes', () => {
		const baseContent = generateHeavyContent(10_000);
		const editPasses = 200;

		// ── Incremental: start with full content, then mutate repeatedly ────
		const incrDoc = new Y.Doc();
		const incrTimeline = attachTimeline(incrDoc);

		const { durationMs: incrMs } = measureTime(() => {
			const ytext = incrTimeline.asText();
			ytext.insert(0, baseContent);

			for (let pass = 0; pass < editPasses; pass++) {
				const len = ytext.length;

				// Simulate different edit patterns each pass:
				switch (pass % 4) {
					case 0: {
						// Replace a sentence in the middle (~50 chars)
						const pos = Math.floor(len * 0.4);
						const deleteLen = Math.min(50, len - pos);
						ytext.delete(pos, deleteLen);
						ytext.insert(pos, `[revised section ${pass}] `);
						break;
					}
					case 1: {
						// Append a line at the end
						ytext.insert(len, `\nAdded note ${pass}. `);
						break;
					}
					case 2: {
						// Delete from the end (trimming)
						const trimLen = Math.min(30, len);
						ytext.delete(len - trimLen, trimLen);
						break;
					}
					case 3: {
						// Insert at the beginning (prepend)
						ytext.insert(0, `[${pass}] `);
						break;
					}
				}
			}
		});
		const finalContent = incrTimeline.read();
		const incrSize = Y.encodeStateAsUpdate(incrDoc).byteLength;

		// ── Pristine: write the same final text in one shot ─────────────────
		const pristineDoc = new Y.Doc();
		const pristineTimeline = attachTimeline(pristineDoc);

		const { durationMs: pristineMs } = measureTime(() => {
			pristineTimeline.write(finalContent);
		});

		const pristineSize = Y.encodeStateAsUpdate(pristineDoc).byteLength;

		const overhead = incrSize - pristineSize;
		const ratio = incrSize / pristineSize;

		console.log('\n=== Y.TEXT: Heavy revision of 10KB note (200 passes) ===');
		console.log(`  Final text length: ${finalContent.length} chars`);
		console.log(`  Edit passes:       ${editPasses}`);
		console.log(
			`  Incremental: ${formatBytes(incrSize)} (${incrMs.toFixed(1)}ms)`,
		);
		console.log(
			`  Pristine:    ${formatBytes(pristineSize)} (${pristineMs.toFixed(1)}ms)`,
		);
		console.log(
			`  Overhead:    +${formatBytes(overhead)} (${ratio.toFixed(2)}x pristine)`,
		);

		incrDoc.destroy();
		pristineDoc.destroy();
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 3: Realistic Writing Session (Table + Document Combined)
// ═══════════════════════════════════════════════════════════════════════════════

describe('realistic writing session (table + document)', () => {
	/**
	 * Simulates 1 hour in a note-taking app like Fuji.
	 *
	 * Setup: 10 existing notes with content (stored in table rows).
	 * Three notes get actively edited during the session:
	 *
	 * - Note A: Brand new note. User types ~5KB of content from scratch.
	 *   50 autosaves fire (set() on the row every ~2 seconds of active typing).
	 *   Content also grows in the document Y.Doc via timeline.
	 *
	 * - Note B: Existing 10KB note. User makes small edits throughout the hour.
	 *   80 autosaves with minor content tweaks to both the row and document.
	 *
	 * - Note C: Metadata-only changes. 20 title renames and tag edits.
	 *   No content changes. Just row-level set() calls.
	 *
	 * The benchmark measures total size across the workspace Y.Doc (table rows)
	 * and all document Y.Docs (content), then compares against a pristine
	 * workspace with the same final state.
	 */
	test('1-hour session: 3 active notes, 10 total, table + document edits', () => {
		const baseContent = generateHeavyContent(10_000);

		// Sentences for progressive typing in Note A
		const typingSentences = [
			'Started a new project today. The goal is to build a local-first notes app. ',
			'The key insight is that CRDTs handle sync so the server stays dumb. ',
			'Spent the morning reading about Yjs internals and LWW registers. ',
			'Afternoon was all implementation. Got basic table CRUD working. ',
			'Tomorrow I need to wire up persistence and cross-tab sync. ',
			'The document API is surprisingly clean once you understand timelines. ',
			'Each document gets its own Y.Doc which keeps content isolated. ',
			'Table rows store metadata while documents store the actual content. ',
			'This separation means row-level LWW and character-level CRDTs coexist. ',
			'Need to benchmark the overhead of this dual-storage approach. ',
		];

		// ═══════════════════════════════════════════════════════════════════
		// Incremental session
		// ═══════════════════════════════════════════════════════════════════

		// Workspace doc (table rows)
		const incrWorkspaceDoc = new Y.Doc();
		const incrTables = createTables(incrWorkspaceDoc, {
			notes: heavyNoteDefinition,
		});

		// Document Y.Docs (content): one per note that has content
		const incrContentDocs: Y.Doc[] = [];
		const incrTimelines: ReturnType<typeof attachTimeline>[] = [];

		const { durationMs: incrMs } = measureTime(() => {
			// Create 10 existing notes with content
			for (let i = 0; i < 10; i++) {
				incrTables.notes.set({
					id: `note-${i}`,
					title: `Existing Note ${i}`,
					content: `content-doc-${i}`, // guid reference
					summary: `Summary for note ${i}`,
					tags: ['existing'],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				// Each note gets a content Y.Doc with the base content
				// Note 0 starts empty (it's the "new note" scenario)
				const contentDoc = new Y.Doc();
				const tl = attachTimeline(contentDoc);
				if (i !== 0) tl.write(baseContent);
				incrContentDocs.push(contentDoc);
				incrTimelines.push(tl);
			}

			// ── Note A: New note, typed from scratch (50 autosaves) ────────
			const noteATl = incrTimelines[0]!;
			const ytext = noteATl.asText();
			let cursor = 0;

			for (let save = 0; save < 50; save++) {
				// Type a sentence
				const sentence = typingSentences[save % typingSentences.length]!;
				ytext.insert(cursor, sentence);
				cursor += sentence.length;

				// Autosave fires: row gets updated with new metadata
				incrTables.notes.set({
					id: 'note-0',
					title: save < 5 ? 'Untitled' : 'Local-First Notes Architecture',
					content: 'content-doc-0',
					summary: save < 10 ? '' : 'Notes on building a local-first app',
					tags: save < 20 ? ['draft'] : ['draft', 'architecture'],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}

			// ── Note B: Existing note, small edits (80 autosaves) ──────────
			const noteBText = incrTimelines[1]!.asText();

			for (let save = 0; save < 80; save++) {
				// Small edit: replace a few chars in the middle
				const len = noteBText.length;
				const pos = Math.floor(len * ((save % 10) / 10));
				const deleteLen = Math.min(10, len - pos);
				noteBText.delete(pos, deleteLen);
				noteBText.insert(pos, `[fix-${save}]`);

				// Autosave
				incrTables.notes.set({
					id: 'note-1',
					title: `Existing Note 1`,
					content: 'content-doc-1',
					summary: `Summary for note 1 (rev ${save})`,
					tags: ['existing'],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}

			// ── Note C: Metadata only (20 row-level edits) ─────────────────
			for (let save = 0; save < 20; save++) {
				incrTables.notes.set({
					id: 'note-2',
					title:
						save % 3 === 0 ? `Note 2: ${save}` : `Renamed Note 2 (${save})`,
					content: 'content-doc-2',
					summary: `Updated summary ${save}`,
					tags: save % 4 === 0 ? ['existing', 'important'] : ['existing'],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});

		// Measure incremental sizes
		const incrWorkspaceSize =
			Y.encodeStateAsUpdate(incrWorkspaceDoc).byteLength;
		let incrContentSize = 0;
		for (const doc of incrContentDocs) {
			incrContentSize += Y.encodeStateAsUpdate(doc).byteLength;
		}
		const incrTotalSize = incrWorkspaceSize + incrContentSize;

		// Capture final state for pristine recreation
		const finalNoteAContent = incrTimelines[0]!.read();
		const finalNoteBContent = incrTimelines[1]!.read();

		// ═══════════════════════════════════════════════════════════════════
		// Pristine: same final state, written once
		// ═══════════════════════════════════════════════════════════════════

		const pristineWorkspaceDoc = new Y.Doc();
		const pristineTables = createTables(pristineWorkspaceDoc, {
			notes: heavyNoteDefinition,
		});
		const pristineContentDocs: Y.Doc[] = [];

		const { durationMs: pristineMs } = measureTime(() => {
			// Recreate all 10 notes with their final state
			for (let i = 0; i < 10; i++) {
				let title: string;
				let summary: string;
				let tags: string[];

				if (i === 0) {
					title = 'Local-First Notes Architecture';
					summary = 'Notes on building a local-first app';
					tags = ['draft', 'architecture'];
				} else if (i === 1) {
					title = 'Existing Note 1';
					summary = 'Summary for note 1 (rev 79)';
					tags = ['existing'];
				} else if (i === 2) {
					title = 'Renamed Note 2 (19)';
					summary = 'Updated summary 19';
					tags = ['existing'];
				} else {
					title = `Existing Note ${i}`;
					summary = `Summary for note ${i}`;
					tags = ['existing'];
				}

				pristineTables.notes.set({
					id: `note-${i}`,
					title,
					content: `content-doc-${i}`,
					summary,
					tags,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				// Content doc: written once with final content
				const contentDoc = new Y.Doc();
				const tl = attachTimeline(contentDoc);
				if (i === 0) {
					tl.write(finalNoteAContent);
				} else if (i === 1) {
					tl.write(finalNoteBContent);
				} else {
					tl.write(baseContent);
				}
				pristineContentDocs.push(contentDoc);
			}
		});

		const pristineWorkspaceSize =
			Y.encodeStateAsUpdate(pristineWorkspaceDoc).byteLength;
		let pristineContentSize = 0;
		for (const doc of pristineContentDocs) {
			pristineContentSize += Y.encodeStateAsUpdate(doc).byteLength;
		}
		const pristineTotalSize = pristineWorkspaceSize + pristineContentSize;

		// ═══════════════════════════════════════════════════════════════════
		// Results
		// ═══════════════════════════════════════════════════════════════════

		const workspaceOverhead = incrWorkspaceSize - pristineWorkspaceSize;
		const contentOverhead = incrContentSize - pristineContentSize;
		const totalOverhead = incrTotalSize - pristineTotalSize;

		console.log(
			'\n=== REALISTIC SESSION: 1 hour, 10 notes, 3 actively edited ===',
		);
		console.log(
			`  Operations: 50 (Note A) + 80 (Note B) + 20 (Note C) row saves`,
		);
		console.log(`              + progressive typing (A) + 80 small edits (B)`);
		console.log(`  ──────────────────────────────────────────────────────────`);
		console.log(`                    Incremental     Pristine       Overhead`);
		console.log(
			`  Workspace rows:   ${formatBytes(incrWorkspaceSize).padEnd(15)} ${formatBytes(pristineWorkspaceSize).padEnd(14)} +${formatBytes(workspaceOverhead)}`,
		);
		console.log(
			`  Content docs:     ${formatBytes(incrContentSize).padEnd(15)} ${formatBytes(pristineContentSize).padEnd(14)} +${formatBytes(contentOverhead)}`,
		);
		console.log(`  ──────────────────────────────────────────────────────────`);
		console.log(
			`  Total:            ${formatBytes(incrTotalSize).padEnd(15)} ${formatBytes(pristineTotalSize).padEnd(14)} +${formatBytes(totalOverhead)} (${(incrTotalSize / pristineTotalSize).toFixed(2)}x)`,
		);
		console.log(
			`  Write time:       ${incrMs.toFixed(0)}ms${' '.repeat(12)} ${pristineMs.toFixed(0)}ms`,
		);

		// Cleanup
		incrWorkspaceDoc.destroy();
		pristineWorkspaceDoc.destroy();
		for (const doc of incrContentDocs) doc.destroy();
		for (const doc of pristineContentDocs) doc.destroy();
	});
});
