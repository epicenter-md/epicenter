/**
 * Tab Manager Markdown Exporter
 *
 * A standalone sync client that connects to the Epicenter sync server
 * and exports tab-manager's Y.Doc state to markdown files in real-time.
 *
 * Architecture:
 * - Tab Manager (browser extension) writes tab state to Y.Doc
 * - Sync Server holds the authoritative Y.Doc in memory
 * - This client connects as a peer and observes Y.Doc changes
 * - Exports markdown files (one per device) with structured JSON + human-readable summary
 *
 * TWO chained extensions handle the pipeline:
 * 1. Persistence — observes Y.Doc updates, debounces, writes markdown files
 * 2. Sync — connects WebSocket after persistence is ready
 *
 * ONE-WAY sync: Y.Doc → Markdown only (read-only export)
 */

import { definition } from '@epicenter/tab-manager/workspace';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { createMarkdownPersistenceExtension } from './markdown-persistence-extension';

console.log('Tab Manager Markdown Exporter starting...');

const client = createWorkspace(definition)
	.withWorkspaceExtension(
		'persistence',
		createMarkdownPersistenceExtension({
			outputDir: './markdown/devices',
			debounceMs: 1000,
		}),
	)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (id) => `ws://localhost:3913/workspaces/${id}`,
		}),
	);

await client.whenReady;
console.log('✓ Connected to sync server at ws://localhost:3913');
console.log(`✓ Workspace: ${definition.id}`);
console.log('✓ Listening for tab changes...');
console.log('✓ Exporting to ./markdown/devices/');
console.log('');
console.log('Press Ctrl+C to stop');

// Graceful shutdown — extensions destroy in reverse order:
// sync disconnects first, then persistence flushes pending writes.
process.on('SIGINT', async () => {
	console.log('\n\nShutting down...');
	await client.destroy();
	console.log('✓ Graceful shutdown complete');
	process.exit(0);
});
