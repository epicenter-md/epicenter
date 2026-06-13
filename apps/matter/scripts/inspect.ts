/**
 * Dogfood the read -> classify pipeline against a real folder of markdown.
 *
 *   bun scripts/inspect.ts [folder]   (default: ../../examples/matter/sample-vault/drafts)
 *
 * Reads the folder from disk with node fs (the headless counterpart to the Tauri
 * vault), runs `readFolder`, and prints the model fields (or raw columns when
 * unmodeled), the per-cell conformance, and the unreadable files. A filesystem
 * proof of the same pure transform the GUI renders.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFolder } from '../src/lib/core/folder';

const dir = process.argv[2] ?? '../../examples/matter/sample-vault/drafts';

const names = (await readdir(dir))
	.filter((name) => name.endsWith('.md'))
	.sort();
const entries = await Promise.all(
	names.map(async (name) => ({
		name,
		content: await readFile(join(dir, name), 'utf8'),
	})),
);

// Load the folder's model if it has one, so inspect shows conformance, not just
// the inferred preview.
const modelText = await readFile(join(dir, 'matter.json'), 'utf8').catch(
	() => undefined,
);

const { rows, view, unreadable } = readFolder(entries, modelText);

const cell = (value: unknown): string => {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
};

console.log(`\nFolder: ${dir}`);
console.log(
	`Files: ${entries.length}   Readable rows: ${rows.length}   Unreadable: ${unreadable.length}`,
);
console.log(
	`Mode: ${view.mode}${view.mode === 'unmodeled' && view.modelError ? ` (model error: ${view.modelError.message})` : ''}\n`,
);

if (view.mode === 'unmodeled') {
	console.log('No model: raw columns (keys only, no inferred kinds):');
	console.log('  ' + view.columns.join(', '));

	console.log('\nRows:');
	const keys = view.columns;
	console.log('  ' + ['file', ...keys].map((k) => k.padEnd(16)).join(''));
	for (const row of rows) {
		const cells = keys.map((k) =>
			cell(row.frontmatter[k]).slice(0, 15).padEnd(16),
		);
		console.log('  ' + row.name.padEnd(16) + cells.join(''));
	}
} else {
	console.log('Model fields:');
	for (const f of view.model.fields) {
		console.log(`  ${f.name.padEnd(14)} ${f.kind}`);
	}

	console.log('\nConformance (state per cell; ! = needs attention):');
	const keys = view.model.fields.map((f) => f.name);
	console.log('  ' + ['file', ...keys].map((k) => k.padEnd(16)).join(''));
	for (const conf of view.conformance) {
		const flag = conf.rowValid ? ' ' : '!';
		const cells = conf.cells.map((c) => c.state.padEnd(16));
		const extras = conf.extras.length ? `  +${conf.extras.length} extra` : '';
		console.log(
			`${flag} ` + conf.row.name.padEnd(16) + cells.join('') + extras,
		);
	}
}

if (unreadable.length) {
	console.log('\nUnreadable (would route to "Can\'t read"):');
	for (const u of unreadable)
		console.log(`  ${u.name.padEnd(16)} ${u.error.message}`);
}
console.log('');
