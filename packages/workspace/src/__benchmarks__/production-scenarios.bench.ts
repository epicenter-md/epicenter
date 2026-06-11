/**
 * Production Scenario Benchmarks
 *
 * Answers: "What does real-world usage look like for storage growth?"
 *
 * Simulates realistic editing sessions: autosave every 2s for 10 minutes,
 * all-day editing across 3 documents. Measures Y.Doc growth across
 * YKV, Y.Map Replace, and Y.Map Field Update strategies.
 */

import { describe, test } from 'bun:test';
import * as Y from 'yjs';
import { attachTable } from '../document/table.js';
import {
	formatBytes,
	generateHeavyContent,
	heavyNoteDefinition,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Autosave: 300 saves to 1 doc over 10 minutes
// ═══════════════════════════════════════════════════════════════════════════════

describe('autosave scenario', () => {
	test('user edits 1 doc, saves every 2s for 10min (300 saves)', () => {
		/**
		 * Realistic scenario: User has 5 notes open.
		 * They're actively editing 1 note. Autosave fires every ~2 seconds.
		 * Over a 10-minute session, that's ~300 saves to the same row.
		 * The other 4 rows sit idle.
		 */
		const contentChars = 20_000; // ~20KB note, realistic for a long doc
		const autosaves = 300; // 10 min ÷ 2s

		function makeRow(id: string, content: string) {
			return {
				id,
				title: `My Document ${id}`,
				content,
				summary: 'A summary',
				tags: ['work', 'notes'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}

		// Simulate progressive typing: content grows slightly each save
		const baseContent = generateHeavyContent(contentChars);
		function contentAtSave(n: number): string {
			const extra = ` [edit ${n}]`;
			return baseContent.slice(0, contentChars - extra.length) + extra;
		}

		// ── YKV ──
		const ykvDoc = new Y.Doc();
		const tables = { notes: attachTable(ykvDoc, 'notes', heavyNoteDefinition) };
		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeRow(`doc-${i}`, baseContent));
		}
		const ykvBaseline = Y.encodeStateAsUpdate(ykvDoc).byteLength;
		for (let s = 1; s <= autosaves; s++) {
			tables.notes.set(makeRow('doc-0', contentAtSave(s)));
		}
		const ykvFinal = Y.encodeStateAsUpdate(ykvDoc).byteLength;

		// ── Y.Map Replace ──
		const replaceDoc = new Y.Doc();
		const replaceRoot = replaceDoc.getMap('notes');
		for (let i = 0; i < 5; i++) {
			const row = new Y.Map();
			for (const [k, v] of Object.entries(makeRow(`doc-${i}`, baseContent)))
				row.set(k, v);
			replaceRoot.set(`doc-${i}`, row);
		}
		const replaceBaseline = Y.encodeStateAsUpdate(replaceDoc).byteLength;
		for (let s = 1; s <= autosaves; s++) {
			const row = new Y.Map();
			for (const [k, v] of Object.entries(makeRow('doc-0', contentAtSave(s))))
				row.set(k, v);
			replaceRoot.set('doc-0', row);
		}
		const replaceFinal = Y.encodeStateAsUpdate(replaceDoc).byteLength;

		// ── Y.Map Field Update ──
		const fieldDoc = new Y.Doc();
		const fieldRoot = fieldDoc.getMap('notes');
		for (let i = 0; i < 5; i++) {
			const row = new Y.Map();
			for (const [k, v] of Object.entries(makeRow(`doc-${i}`, baseContent)))
				row.set(k, v);
			fieldRoot.set(`doc-${i}`, row);
		}
		const fieldBaseline = Y.encodeStateAsUpdate(fieldDoc).byteLength;
		for (let s = 1; s <= autosaves; s++) {
			const row = fieldRoot.get('doc-0') as Y.Map<unknown>;
			const data = makeRow('doc-0', contentAtSave(s));
			for (const [k, v] of Object.entries(data)) row.set(k, v);
		}
		const fieldFinal = Y.encodeStateAsUpdate(fieldDoc).byteLength;

		console.log(
			'\n=== PRODUCTION: AUTOSAVE: 300 saves to 1 doc over 10 min ===',
		);
		console.log(`  5 notes × 20K chars, 1 being actively edited`);
		console.log(`  ────────────────────────────────────────────────────────`);
		console.log(`                  Baseline     After 300     Growth`);
		console.log(
			`  YKV:            ${formatBytes(ykvBaseline).padEnd(12)} ${formatBytes(ykvFinal).padEnd(13)} +${formatBytes(ykvFinal - ykvBaseline)}`,
		);
		console.log(
			`  Y.Map Replace:  ${formatBytes(replaceBaseline).padEnd(12)} ${formatBytes(replaceFinal).padEnd(13)} +${formatBytes(replaceFinal - replaceBaseline)}`,
		);
		console.log(
			`  Y.Map Field:    ${formatBytes(fieldBaseline).padEnd(12)} ${formatBytes(fieldFinal).padEnd(13)} +${formatBytes(fieldFinal - fieldBaseline)}`,
		);
		console.log(`  ────────────────────────────────────────────────────────`);
		console.log(
			`  YKV saves ${formatBytes(fieldFinal - fieldBaseline - (ykvFinal - ykvBaseline))} vs Y.Map Field update`,
		);
		console.log(
			`  YKV saves ${formatBytes(replaceFinal - replaceBaseline - (ykvFinal - ykvBaseline))} vs Y.Map Replace`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// All-Day Editing: 2000 saves across 3 documents over 8 hours
// ═══════════════════════════════════════════════════════════════════════════════

describe('all-day editing scenario', () => {
	test('3 documents, 8hr session, 2000 total saves', () => {
		/**
		 * Power user: 3 documents getting edited throughout the day.
		 * ~2000 total saves across 3 documents over 8 hours.
		 */
		const contentChars = 30_000;
		const totalSaves = 2000;
		const baseContent = generateHeavyContent(contentChars);

		function makeRowAtRevision(id: string, v: number) {
			const extra = ` [revision ${v}]`;
			return {
				id,
				title: `Document ${id}`,
				content: baseContent.slice(0, contentChars - extra.length) + extra,
				summary: `Rev ${v} summary`,
				tags: ['active'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}

		// ── YKV ──
		const ykvDoc = new Y.Doc();
		const tables = { notes: attachTable(ykvDoc, 'notes', heavyNoteDefinition) };
		for (let i = 0; i < 5; i++)
			tables.notes.set(makeRowAtRevision(`doc-${i}`, 0));
		for (let s = 1; s <= totalSaves; s++) {
			const docIdx = s % 3; // rotate across 3 active documents
			tables.notes.set(makeRowAtRevision(`doc-${docIdx}`, s));
		}
		const ykvSize = Y.encodeStateAsUpdate(ykvDoc).byteLength;

		// ── Y.Map Field Update ──
		const fieldDoc = new Y.Doc();
		const fieldRoot = fieldDoc.getMap('notes');
		for (let i = 0; i < 5; i++) {
			const row = new Y.Map();
			for (const [k, v] of Object.entries(makeRowAtRevision(`doc-${i}`, 0)))
				row.set(k, v);
			fieldRoot.set(`doc-${i}`, row);
		}
		for (let s = 1; s <= totalSaves; s++) {
			const docIdx = s % 3;
			const row = fieldRoot.get(`doc-${docIdx}`) as Y.Map<unknown>;
			for (const [k, v] of Object.entries(
				makeRowAtRevision(`doc-${docIdx}`, s),
			))
				row.set(k, v);
		}
		const fieldSize = Y.encodeStateAsUpdate(fieldDoc).byteLength;

		console.log(
			'\n=== PRODUCTION: ALL-DAY SESSION: 2000 saves across 3 documents ===',
		);
		console.log(`  5 notes × 30K chars, 3 actively edited over 8 hours`);
		console.log(`  ────────────────────────────────────────────────────────`);
		console.log(`  YKV:           ${formatBytes(ykvSize)}`);
		console.log(`  Y.Map Field:   ${formatBytes(fieldSize)}`);
		console.log(`  ────────────────────────────────────────────────────────`);
		console.log(
			`  Difference:    ${formatBytes(fieldSize - ykvSize)} more with Y.Map Field (${((fieldSize / ykvSize - 1) * 100).toFixed(1)}% bloat)`,
		);
	});
});
