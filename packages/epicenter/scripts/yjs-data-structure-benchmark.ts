/**
 * ============================================================================
 * YJS Data Structure Benchmark: Arrays vs Maps, Plain Objects vs Nested Y.Maps
 * ============================================================================
 *
 * This benchmark compares four approaches for modeling a data table in YJS:
 *
 *   1. Y.Map<id, PlainObject>  - Map with row IDs as keys, plain JS objects as values
 *   2. Y.Array<PlainObject>    - Array of plain JS objects
 *   3. Y.Map<id, Y.Map>        - Map with row IDs as keys, nested Y.Maps as values
 *   4. Y.Array<Y.Map>          - Array of nested Y.Maps
 *
 * We test three update scenarios:
 *
 *   A. SINGLE COLUMN UPDATES  - Update one property per row (e.g., increment age)
 *   B. FULL ROW REPLACEMENTS  - Replace entire row with new data
 *   C. MIXED UPDATES          - 70% single column, 30% full row (realistic usage)
 *
 * Key questions answered:
 *
 *   - How does storage grow with each approach?
 *   - How much does GC help for each approach?
 *   - When are plain objects actually better than nested Y.Maps?
 *   - What are the performance differences?
 *
 * ============================================================================
 * TL;DR RECOMMENDATIONS
 * ============================================================================
 *
 * | Scenario                          | Best Choice              | Why                           |
 * |-----------------------------------|--------------------------|-------------------------------|
 * | Frequent single-column updates    | Y.Map<id, Y.Map>         | Minimal tombstones per update |
 * | Real-time collaboration           | Y.Map<id, Y.Map>         | Concurrent edits merge        |
 * | Write-once / read-many data       | Y.Map<id, PlainObject>   | Simpler, smaller initial size |
 * | Full row replacements only        | Y.Map<id, PlainObject>   | Less overhead per row         |
 * | Need ordering + frequent updates  | Y.Array<Y.Map>           | Maintains order, granular     |
 * | Append-only logs                  | Y.Array<PlainObject>     | Efficient batching            |
 *
 * ============================================================================
 */

import * as Y from 'yjs';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
	NUM_ROWS: 1000,
	NUM_COLUMNS: 5, // id, name, age, email, active
	UPDATES_PER_ROW: 10,
	NUM_DELETIONS: 200,
	NUM_RECREATIONS: 100,
};

// ============================================================================
// Data Helpers
// ============================================================================

type PlainRow = {
	id: string;
	name: string;
	age: number;
	email: string;
	active: boolean;
};

function createPlainRow(id: string, suffix = ''): PlainRow {
	return {
		id,
		name: `User ${id}${suffix}`,
		age: Math.floor(Math.random() * 50) + 20,
		email: `user${id}${suffix}@example.com`,
		active: true,
	};
}

function createYMapRow(_doc: Y.Doc, id: string, suffix = ''): Y.Map<unknown> {
	const row = new Y.Map<unknown>();
	row.set('id', id);
	row.set('name', `User ${id}${suffix}`);
	row.set('age', Math.floor(Math.random() * 50) + 20);
	row.set('email', `user${id}${suffix}@example.com`);
	row.set('active', true);
	return row;
}

// ============================================================================
// Measurement Utilities
// ============================================================================

function getDocSize(doc: Y.Doc): number {
	return Y.encodeStateAsUpdate(doc).byteLength;
}

function countStructs(doc: Y.Doc): {
	total: number;
	deleted: number;
	gc: number;
} {
	let total = 0;
	let deleted = 0;
	let gc = 0;

	// Access internal store structure
	const store = (doc as any).store;
	for (const structs of store.clients.values()) {
		for (const struct of structs) {
			total++;
			if ((struct as any).deleted) {
				deleted++;
			}
			if (struct.constructor.name === 'GC') {
				gc++;
			}
		}
	}

	return { total, deleted, gc };
}

// ============================================================================
// Update Strategies
// ============================================================================

type UpdateStrategy = 'single-column' | 'full-row' | 'mixed';

/**
 * Single Column Update: Only update one property (age)
 * - Best case for nested Y.Maps (minimal tombstone)
 * - Worst case for plain objects (whole object replaced for one change)
 */
function singleColumnUpdate(row: PlainRow): PlainRow {
	return { ...row, age: row.age + 1 };
}

/**
 * Full Row Replacement: Update all properties
 * - Similar cost for both approaches
 * - Plain objects may have slight edge (less overhead)
 */
function fullRowUpdate(row: PlainRow): PlainRow {
	return {
		id: row.id,
		name: row.name + '!',
		age: row.age + 1,
		email: row.email.replace('@', '+updated@'),
		active: !row.active,
	};
}

// ============================================================================
// Benchmark Implementations
// ============================================================================

interface BenchmarkResult {
	name: string;
	gcEnabled: boolean;
	updateStrategy: UpdateStrategy;
	timings: {
		insert: number;
		update: number;
		delete: number;
		recreate: number;
	};
	sizes: {
		afterInsert: number;
		afterUpdate: number;
		afterDelete: number;
		afterRecreate: number;
	};
	structs: {
		total: number;
		deleted: number;
		gc: number;
	};
}

// ---------------------------------------------------------------------------
// Y.Map<id, PlainObject>
// ---------------------------------------------------------------------------

function benchmarkMapPlain(
	gcEnabled: boolean,
	strategy: UpdateStrategy,
): BenchmarkResult {
	const doc = new Y.Doc({ gc: gcEnabled });
	const ymap = doc.getMap<PlainRow>('data');

	const result: BenchmarkResult = {
		name: 'Y.Map<id, PlainObject>',
		gcEnabled,
		updateStrategy: strategy,
		timings: { insert: 0, update: 0, delete: 0, recreate: 0 },
		sizes: { afterInsert: 0, afterUpdate: 0, afterDelete: 0, afterRecreate: 0 },
		structs: { total: 0, deleted: 0, gc: 0 },
	};

	// INSERT
	let start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_ROWS; i++) {
			ymap.set(`row-${i}`, createPlainRow(`${i}`));
		}
	});
	result.timings.insert = performance.now() - start;
	result.sizes.afterInsert = getDocSize(doc);

	// UPDATE
	start = performance.now();
	for (let u = 0; u < CONFIG.UPDATES_PER_ROW; u++) {
		doc.transact(() => {
			for (let i = 0; i < CONFIG.NUM_ROWS; i++) {
				const existing = ymap.get(`row-${i}`)!;
				switch (strategy) {
					case 'single-column':
						ymap.set(`row-${i}`, singleColumnUpdate(existing));
						break;
					case 'full-row':
						ymap.set(`row-${i}`, fullRowUpdate(existing));
						break;
					default: {
						// mixed: 70% single, 30% full
						const updateFn =
							Math.random() < 0.7 ? singleColumnUpdate : fullRowUpdate;
						ymap.set(`row-${i}`, updateFn(existing));
						break;
					}
				}
			}
		});
	}
	result.timings.update = performance.now() - start;
	result.sizes.afterUpdate = getDocSize(doc);

	// DELETE
	start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_DELETIONS; i++) {
			ymap.delete(`row-${i}`);
		}
	});
	result.timings.delete = performance.now() - start;
	result.sizes.afterDelete = getDocSize(doc);

	// RECREATE
	start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_RECREATIONS; i++) {
			ymap.set(`row-${i}`, createPlainRow(`${i}`, '-v2'));
		}
	});
	result.timings.recreate = performance.now() - start;
	result.sizes.afterRecreate = getDocSize(doc);

	result.structs = countStructs(doc);
	return result;
}

// ---------------------------------------------------------------------------
// Y.Array<PlainObject>
// ---------------------------------------------------------------------------

function benchmarkArrayPlain(
	gcEnabled: boolean,
	strategy: UpdateStrategy,
): BenchmarkResult {
	const doc = new Y.Doc({ gc: gcEnabled });
	const yarray = doc.getArray<PlainRow>('data');

	const result: BenchmarkResult = {
		name: 'Y.Array<PlainObject>',
		gcEnabled,
		updateStrategy: strategy,
		timings: { insert: 0, update: 0, delete: 0, recreate: 0 },
		sizes: { afterInsert: 0, afterUpdate: 0, afterDelete: 0, afterRecreate: 0 },
		structs: { total: 0, deleted: 0, gc: 0 },
	};

	// INSERT
	let start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_ROWS; i++) {
			yarray.push([createPlainRow(`${i}`)]);
		}
	});
	result.timings.insert = performance.now() - start;
	result.sizes.afterInsert = getDocSize(doc);

	// UPDATE (must delete + reinsert for arrays)
	start = performance.now();
	for (let u = 0; u < CONFIG.UPDATES_PER_ROW; u++) {
		doc.transact(() => {
			for (let i = 0; i < CONFIG.NUM_ROWS; i++) {
				const existing = yarray.get(i);
				yarray.delete(i, 1);
				switch (strategy) {
					case 'single-column':
						yarray.insert(i, [singleColumnUpdate(existing)]);
						break;
					case 'full-row':
						yarray.insert(i, [fullRowUpdate(existing)]);
						break;
					default: {
						const updateFn =
							Math.random() < 0.7 ? singleColumnUpdate : fullRowUpdate;
						yarray.insert(i, [updateFn(existing)]);
						break;
					}
				}
			}
		});
	}
	result.timings.update = performance.now() - start;
	result.sizes.afterUpdate = getDocSize(doc);

	// DELETE
	start = performance.now();
	doc.transact(() => {
		yarray.delete(CONFIG.NUM_ROWS - CONFIG.NUM_DELETIONS, CONFIG.NUM_DELETIONS);
	});
	result.timings.delete = performance.now() - start;
	result.sizes.afterDelete = getDocSize(doc);

	// RECREATE
	start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_RECREATIONS; i++) {
			yarray.push([
				createPlainRow(`${CONFIG.NUM_ROWS - CONFIG.NUM_DELETIONS + i}`, '-v2'),
			]);
		}
	});
	result.timings.recreate = performance.now() - start;
	result.sizes.afterRecreate = getDocSize(doc);

	result.structs = countStructs(doc);
	return result;
}

// ---------------------------------------------------------------------------
// Y.Map<id, Y.Map>
// ---------------------------------------------------------------------------

function benchmarkMapYMap(
	gcEnabled: boolean,
	strategy: UpdateStrategy,
): BenchmarkResult {
	const doc = new Y.Doc({ gc: gcEnabled });
	const ymap = doc.getMap<Y.Map<unknown>>('data');

	const result: BenchmarkResult = {
		name: 'Y.Map<id, Y.Map>',
		gcEnabled,
		updateStrategy: strategy,
		timings: { insert: 0, update: 0, delete: 0, recreate: 0 },
		sizes: { afterInsert: 0, afterUpdate: 0, afterDelete: 0, afterRecreate: 0 },
		structs: { total: 0, deleted: 0, gc: 0 },
	};

	// INSERT
	let start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_ROWS; i++) {
			ymap.set(`row-${i}`, createYMapRow(doc, `${i}`));
		}
	});
	result.timings.insert = performance.now() - start;
	result.sizes.afterInsert = getDocSize(doc);

	// UPDATE
	start = performance.now();
	for (let u = 0; u < CONFIG.UPDATES_PER_ROW; u++) {
		doc.transact(() => {
			for (let i = 0; i < CONFIG.NUM_ROWS; i++) {
				const row = ymap.get(`row-${i}`)!;
				switch (strategy) {
					case 'single-column':
						// Only update age - creates 1 tombstone
						row.set('age', (row.get('age') as number) + 1);
						break;
					case 'full-row':
						// Update all columns - creates 5 tombstones (one per column)
						row.set('name', (row.get('name') as string) + '!');
						row.set('age', (row.get('age') as number) + 1);
						row.set(
							'email',
							(row.get('email') as string).replace('@', '+updated@'),
						);
						row.set('active', !(row.get('active') as boolean));
						break;
					default:
						// mixed
						if (Math.random() < 0.7) {
							row.set('age', (row.get('age') as number) + 1);
						} else {
							row.set('name', (row.get('name') as string) + '!');
							row.set('age', (row.get('age') as number) + 1);
							row.set(
								'email',
								(row.get('email') as string).replace('@', '+updated@'),
							);
							row.set('active', !(row.get('active') as boolean));
						}
						break;
				}
			}
		});
	}
	result.timings.update = performance.now() - start;
	result.sizes.afterUpdate = getDocSize(doc);

	// DELETE
	start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_DELETIONS; i++) {
			ymap.delete(`row-${i}`);
		}
	});
	result.timings.delete = performance.now() - start;
	result.sizes.afterDelete = getDocSize(doc);

	// RECREATE
	start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_RECREATIONS; i++) {
			ymap.set(`row-${i}`, createYMapRow(doc, `${i}`, '-v2'));
		}
	});
	result.timings.recreate = performance.now() - start;
	result.sizes.afterRecreate = getDocSize(doc);

	result.structs = countStructs(doc);
	return result;
}

// ---------------------------------------------------------------------------
// Y.Array<Y.Map>
// ---------------------------------------------------------------------------

function benchmarkArrayYMap(
	gcEnabled: boolean,
	strategy: UpdateStrategy,
): BenchmarkResult {
	const doc = new Y.Doc({ gc: gcEnabled });
	const yarray = doc.getArray<Y.Map<unknown>>('data');

	const result: BenchmarkResult = {
		name: 'Y.Array<Y.Map>',
		gcEnabled,
		updateStrategy: strategy,
		timings: { insert: 0, update: 0, delete: 0, recreate: 0 },
		sizes: { afterInsert: 0, afterUpdate: 0, afterDelete: 0, afterRecreate: 0 },
		structs: { total: 0, deleted: 0, gc: 0 },
	};

	// INSERT
	let start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_ROWS; i++) {
			yarray.push([createYMapRow(doc, `${i}`)]);
		}
	});
	result.timings.insert = performance.now() - start;
	result.sizes.afterInsert = getDocSize(doc);

	// UPDATE (can update in-place since Y.Map is mutable)
	start = performance.now();
	for (let u = 0; u < CONFIG.UPDATES_PER_ROW; u++) {
		doc.transact(() => {
			for (let i = 0; i < CONFIG.NUM_ROWS; i++) {
				const row = yarray.get(i);
				switch (strategy) {
					case 'single-column':
						row.set('age', (row.get('age') as number) + 1);
						break;
					case 'full-row':
						row.set('name', (row.get('name') as string) + '!');
						row.set('age', (row.get('age') as number) + 1);
						row.set(
							'email',
							(row.get('email') as string).replace('@', '+updated@'),
						);
						row.set('active', !(row.get('active') as boolean));
						break;
					default:
						if (Math.random() < 0.7) {
							row.set('age', (row.get('age') as number) + 1);
						} else {
							row.set('name', (row.get('name') as string) + '!');
							row.set('age', (row.get('age') as number) + 1);
							row.set(
								'email',
								(row.get('email') as string).replace('@', '+updated@'),
							);
							row.set('active', !(row.get('active') as boolean));
						}
						break;
				}
			}
		});
	}
	result.timings.update = performance.now() - start;
	result.sizes.afterUpdate = getDocSize(doc);

	// DELETE
	start = performance.now();
	doc.transact(() => {
		yarray.delete(CONFIG.NUM_ROWS - CONFIG.NUM_DELETIONS, CONFIG.NUM_DELETIONS);
	});
	result.timings.delete = performance.now() - start;
	result.sizes.afterDelete = getDocSize(doc);

	// RECREATE
	start = performance.now();
	doc.transact(() => {
		for (let i = 0; i < CONFIG.NUM_RECREATIONS; i++) {
			yarray.push([
				createYMapRow(
					doc,
					`${CONFIG.NUM_ROWS - CONFIG.NUM_DELETIONS + i}`,
					'-v2',
				),
			]);
		}
	});
	result.timings.recreate = performance.now() - start;
	result.sizes.afterRecreate = getDocSize(doc);

	result.structs = countStructs(doc);
	return result;
}

// ============================================================================
// Reporting
// ============================================================================

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
	if (ms < 1000) return `${ms.toFixed(1)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(1)}%`;
}

function printStrategyResults(
	results: BenchmarkResult[],
	strategy: UpdateStrategy,
) {
	const strategyLabel =
		strategy === 'single-column'
			? 'SINGLE COLUMN UPDATES (best case for Y.Map nested)'
			: strategy === 'full-row'
				? 'FULL ROW REPLACEMENTS (when plain objects may win)'
				: 'MIXED UPDATES (70% single column, 30% full row)';

	console.log(`\n${'═'.repeat(100)}`);
	console.log(`  ${strategyLabel}`);
	console.log(`${'═'.repeat(100)}`);

	const withGC = results.filter((r) => r.gcEnabled);
	const withoutGC = results.filter((r) => !r.gcEnabled);

	for (const [label, group] of [
		['GC ENABLED', withGC],
		['GC DISABLED', withoutGC],
	] as const) {
		console.log(`\n  ${label}`);
		console.log(`  ${'─'.repeat(96)}`);

		// Performance table
		console.log(
			'\n  ' +
				'Structure'.padEnd(24) +
				'Insert'.padStart(10) +
				'Update'.padStart(10) +
				'Delete'.padStart(10) +
				'Recreate'.padStart(10) +
				'│' +
				'Final Size'.padStart(12) +
				'Growth'.padStart(10),
		);
		console.log('  ' + '─'.repeat(96));

		for (const r of group) {
			const growth = r.sizes.afterRecreate / r.sizes.afterInsert - 1;
			console.log(
				'  ' +
					r.name.padEnd(24) +
					formatTime(r.timings.insert).padStart(10) +
					formatTime(r.timings.update).padStart(10) +
					formatTime(r.timings.delete).padStart(10) +
					formatTime(r.timings.recreate).padStart(10) +
					'│' +
					formatBytes(r.sizes.afterRecreate).padStart(12) +
					formatPercent(growth).padStart(10),
			);
		}

		// Struct counts
		console.log(
			'\n  ' +
				'Structure'.padEnd(24) +
				'Total Structs'.padStart(14) +
				'Deleted'.padStart(10) +
				'GC'.padStart(8) +
				'Tombstone %'.padStart(14),
		);
		console.log('  ' + '─'.repeat(70));

		for (const r of group) {
			const tombstoneRatio =
				r.structs.total > 0 ? r.structs.deleted / r.structs.total : 0;
			console.log(
				'  ' +
					r.name.padEnd(24) +
					r.structs.total.toString().padStart(14) +
					r.structs.deleted.toString().padStart(10) +
					r.structs.gc.toString().padStart(8) +
					formatPercent(tombstoneRatio).padStart(14),
			);
		}
	}
}

function printAnalysis(allResults: BenchmarkResult[]) {
	console.log(`\n${'═'.repeat(100)}`);
	console.log('  ANALYSIS & RECOMMENDATIONS');
	console.log(`${'═'.repeat(100)}`);

	// Group by strategy
	const singleCol = allResults.filter(
		(r) => r.updateStrategy === 'single-column' && r.gcEnabled,
	);
	const fullRow = allResults.filter(
		(r) => r.updateStrategy === 'full-row' && r.gcEnabled,
	);

	// Find winners
	const singleColBySize = [...singleCol].sort(
		(a, b) => a.sizes.afterRecreate - b.sizes.afterRecreate,
	);
	const fullRowBySize = [...fullRow].sort(
		(a, b) => a.sizes.afterRecreate - b.sizes.afterRecreate,
	);

	console.log('\n  STORAGE EFFICIENCY (with GC enabled)');
	console.log('  ' + '─'.repeat(70));

	console.log('\n  Single Column Updates - Final Size Ranking:');
	singleColBySize.forEach((r, i) => {
		const marker = i === 0 ? ' ★ BEST' : '';
		console.log(
			`    ${i + 1}. ${r.name.padEnd(24)} ${formatBytes(r.sizes.afterRecreate).padStart(10)}${marker}`,
		);
	});

	console.log('\n  Full Row Replacements - Final Size Ranking:');
	fullRowBySize.forEach((r, i) => {
		const marker = i === 0 ? ' ★ BEST' : '';
		console.log(
			`    ${i + 1}. ${r.name.padEnd(24)} ${formatBytes(r.sizes.afterRecreate).padStart(10)}${marker}`,
		);
	});

	// Compare plain vs nested for each strategy
	console.log('\n  PLAIN OBJECTS vs NESTED Y.MAPS');
	console.log('  ' + '─'.repeat(70));

	const mapPlainSingle = singleCol.find((r) =>
		r.name.includes('Map<id, Plain'),
	)!;
	const mapYMapSingle = singleCol.find((r) =>
		r.name.includes('Map<id, Y.Map'),
	)!;
	const mapPlainFull = fullRow.find((r) => r.name.includes('Map<id, Plain'))!;
	const mapYMapFull = fullRow.find((r) => r.name.includes('Map<id, Y.Map'))!;

	console.log('\n  Single Column Updates:');
	console.log(
		`    Plain objects: ${formatBytes(mapPlainSingle.sizes.afterRecreate)}`,
	);
	console.log(
		`    Nested Y.Maps: ${formatBytes(mapYMapSingle.sizes.afterRecreate)}`,
	);
	const singleDiff =
		mapPlainSingle.sizes.afterRecreate - mapYMapSingle.sizes.afterRecreate;
	if (singleDiff > 0) {
		console.log(
			`    → Nested Y.Maps saves ${formatBytes(singleDiff)} (${formatPercent(singleDiff / mapPlainSingle.sizes.afterRecreate)})`,
		);
	} else {
		console.log(
			`    → Plain objects saves ${formatBytes(-singleDiff)} (${formatPercent(-singleDiff / mapYMapSingle.sizes.afterRecreate)})`,
		);
	}

	console.log('\n  Full Row Replacements:');
	console.log(
		`    Plain objects: ${formatBytes(mapPlainFull.sizes.afterRecreate)}`,
	);
	console.log(
		`    Nested Y.Maps: ${formatBytes(mapYMapFull.sizes.afterRecreate)}`,
	);
	const fullDiff =
		mapPlainFull.sizes.afterRecreate - mapYMapFull.sizes.afterRecreate;
	if (fullDiff > 0) {
		console.log(
			`    → Nested Y.Maps saves ${formatBytes(fullDiff)} (${formatPercent(fullDiff / mapPlainFull.sizes.afterRecreate)})`,
		);
	} else {
		console.log(
			`    → Plain objects saves ${formatBytes(-fullDiff)} (${formatPercent(-fullDiff / mapYMapFull.sizes.afterRecreate)})`,
		);
	}

	// GC impact analysis
	console.log('\n  GC IMPACT');
	console.log('  ' + '─'.repeat(70));

	const strategies: UpdateStrategy[] = ['single-column', 'full-row'];
	for (const strategy of strategies) {
		const label = strategy === 'single-column' ? 'Single Column' : 'Full Row';
		console.log(`\n  ${label} Updates:`);

		const gcOn = allResults.filter(
			(r) => r.updateStrategy === strategy && r.gcEnabled,
		);
		const gcOff = allResults.filter(
			(r) => r.updateStrategy === strategy && !r.gcEnabled,
		);

		for (const on of gcOn) {
			const off = gcOff.find((r) => r.name === on.name)!;
			const reduction = 1 - on.sizes.afterRecreate / off.sizes.afterRecreate;
			console.log(
				`    ${on.name.padEnd(24)} ${formatBytes(off.sizes.afterRecreate)} → ${formatBytes(on.sizes.afterRecreate)} (${formatPercent(reduction)} reduction)`,
			);
		}
	}

	// Decision guide
	console.log(`\n${'═'.repeat(100)}`);
	console.log('  DECISION GUIDE');
	console.log(`${'═'.repeat(100)}`);

	console.log(`
  Use Y.Map<id, PlainObject> when:
    ✓ Data is write-once or rarely updated
    ✓ Updates always replace the entire row (form submissions)
    ✓ You don't need concurrent edit merging (single user)
    ✓ Simpler mental model is worth the tradeoff
    ✓ GC is enabled (critical for managing tombstone growth)

  Use Y.Map<id, Y.Map> when:
    ✓ Individual columns update frequently (cell edits)
    ✓ Multiple users may edit the same row concurrently
    ✓ You need per-field conflict resolution
    ✓ Undo/redo needs to track individual field changes
    ✓ Your API exposes granular cell-level updates

  Use Y.Array<*> variants when:
    ✓ Row ordering matters and changes
    ✓ You need to insert rows at specific positions
    ✓ Append-only patterns (logs, feeds)
    ✗ Avoid if you need fast lookup by ID (O(n) scan required)

  GC Considerations:
    • GC enabled:  Plain objects get ~80% size reduction (content discarded)
    • GC enabled:  Nested Y.Maps get ~20-30% reduction (small values)
    • GC disabled: Plain objects grow ~10x with frequent updates (content kept)
    • GC disabled: Nested Y.Maps grow ~2x (only primitive tombstones)
`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	console.log(`${'═'.repeat(100)}`);
	console.log('  YJS DATA STRUCTURE BENCHMARK');
	console.log(`${'═'.repeat(100)}`);
	console.log(`
  Configuration:
    Rows: ${CONFIG.NUM_ROWS}
    Columns per row: ${CONFIG.NUM_COLUMNS}
    Updates per row: ${CONFIG.UPDATES_PER_ROW}
    Deletions: ${CONFIG.NUM_DELETIONS}
    Recreations: ${CONFIG.NUM_RECREATIONS}
`);

	const allResults: BenchmarkResult[] = [];
	const strategies: UpdateStrategy[] = ['single-column', 'full-row', 'mixed'];
	const benchmarks = [
		benchmarkMapPlain,
		benchmarkArrayPlain,
		benchmarkMapYMap,
		benchmarkArrayYMap,
	];

	for (const strategy of strategies) {
		console.log(`Running ${strategy} benchmarks...`);
		const strategyResults: BenchmarkResult[] = [];

		for (const gcEnabled of [true, false]) {
			for (const benchmark of benchmarks) {
				const result = benchmark(gcEnabled, strategy);
				strategyResults.push(result);
				allResults.push(result);
			}
		}

		printStrategyResults(strategyResults, strategy);
	}

	printAnalysis(allResults);
}

main().catch(console.error);
