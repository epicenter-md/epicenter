#!/usr/bin/env bun
/**
 * Reddit Import Test Script
 *
 * Run with: bun run packages/epicenter/src/ingest/reddit/import-test.ts [path-to-zip]
 *
 * If no path provided, looks for reddit_export.zip in the project root.
 */

import {
	createRedditWorkspace,
	importRedditExport,
	previewRedditExport,
} from './index.js';

async function main() {
	const zipPath = process.argv[2] ?? 'reddit_export.zip';

	console.log(`\n=== Reddit Import Test ===\n`);
	console.log(`Loading: ${zipPath}`);

	// Load the ZIP file
	const file = Bun.file(zipPath);
	if (!(await file.exists())) {
		console.error(`\nError: File not found: ${zipPath}`);
		console.error(
			`\nUsage: bun run import-test.ts [path-to-reddit-export.zip]`,
		);
		process.exit(1);
	}

	const startTime = performance.now();

	// ═══════════════════════════════════════════════════════════════════════════
	// PREVIEW
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\n--- Preview ---\n');
	const previewStart = performance.now();
	const preview = await previewRedditExport(file);
	const previewTime = performance.now() - previewStart;

	console.log('Table row counts:');
	for (const [table, count] of Object.entries(preview.tables)) {
		console.log(`  ${table.padEnd(20)} ${count.toString().padStart(6)}`);
	}
	console.log(
		`  ${'TOTAL'.padEnd(20)} ${preview.totalRows.toString().padStart(6)}`,
	);

	console.log('\nKV fields present:');
	for (const [key, present] of Object.entries(preview.kv)) {
		console.log(`  ${key.padEnd(20)} ${present ? '✓' : '-'}`);
	}

	console.log(`\nPreview time: ${previewTime.toFixed(2)}ms`);

	// ═══════════════════════════════════════════════════════════════════════════
	// IMPORT
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\n--- Import ---\n');

	// Create workspace client
	const workspace = createRedditWorkspace();

	// Import with progress reporting
	const importStart = performance.now();
	const stats = await importRedditExport(file, workspace, {
		onProgress: (progress) => {
			const tableInfo = progress.table ? ` (${progress.table})` : '';
			console.log(
				`  [${progress.phase}] ${progress.current}/${progress.total}${tableInfo}`,
			);
		},
	});
	const importTime = performance.now() - importStart;

	console.log('\n--- Results ---\n');
	console.log('Imported row counts:');
	for (const [table, count] of Object.entries(stats.tables)) {
		console.log(`  ${table.padEnd(20)} ${count.toString().padStart(6)}`);
	}
	console.log(
		`  ${'KV entries'.padEnd(20)} ${stats.kv.toString().padStart(6)}`,
	);
	console.log(
		`  ${'TOTAL'.padEnd(20)} ${stats.totalRows.toString().padStart(6)}`,
	);

	console.log(`\nImport time: ${importTime.toFixed(2)}ms`);
	console.log(`Total time: ${(performance.now() - startTime).toFixed(2)}ms`);

	// ═══════════════════════════════════════════════════════════════════════════
	// VERIFY
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\n--- Verification ---\n');

	// Check some sample data
	const postsCount = workspace.tables.posts.count();
	const commentsCount = workspace.tables.comments.count();
	const postVotesCount = workspace.tables.postVotes.count();

	console.log(`posts table count:     ${postsCount}`);
	console.log(`comments table count:  ${commentsCount}`);
	console.log(`postVotes table count: ${postVotesCount}`);

	// Verify counts match
	const postsMatches = postsCount === stats.tables.posts;
	const commentsMatches = commentsCount === stats.tables.comments;
	const postVotesMatches = postVotesCount === stats.tables.postVotes;

	if (postsMatches && commentsMatches && postVotesMatches) {
		console.log('\n✓ All counts verified!\n');
	} else {
		console.log('\n✗ Count mismatch detected!\n');
		if (!postsMatches)
			console.log(`  posts: expected ${stats.tables.posts}, got ${postsCount}`);
		if (!commentsMatches)
			console.log(
				`  comments: expected ${stats.tables.comments}, got ${commentsCount}`,
			);
		if (!postVotesMatches)
			console.log(
				`  postVotes: expected ${stats.tables.postVotes}, got ${postVotesCount}`,
			);
	}

	// Cleanup
	await workspace.destroy();
}

main().catch((err) => {
	console.error('\nError:', err);
	process.exit(1);
});
