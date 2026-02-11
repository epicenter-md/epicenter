/**
 * Demo: Yjs Root vs Nested Map Behavior
 *
 * This script demonstrates the critical difference between:
 * - doc.getMap('name') at root level (safe, merges)
 * - map.set('key', new Y.Map()) at nested level (can collide, one wins)
 *
 * Run with: bun scripts/demo-yjs-nested-map-lww.ts
 */

import * as Y from 'yjs';

// Helper to sync two docs (simulates network sync)
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
	const state1 = Y.encodeStateAsUpdate(doc1);
	const state2 = Y.encodeStateAsUpdate(doc2);
	Y.applyUpdate(doc1, state2);
	Y.applyUpdate(doc2, state1);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('DEMO 1: Root-level getMap() - SAFE');
console.log(
	'═══════════════════════════════════════════════════════════════\n',
);

{
	const docA = new Y.Doc();
	const docB = new Y.Doc();

	// Both clients get the root-level "users" map
	const usersA = docA.getMap('users');
	const usersB = docB.getMap('users');

	// Both clients add different data BEFORE syncing
	usersA.set('alice', 'admin');
	usersB.set('bob', 'editor');

	console.log('Before sync:');
	console.log('  Doc A users:', usersA.toJSON());
	console.log('  Doc B users:', usersB.toJSON());

	// Sync
	syncDocs(docA, docB);

	console.log('\nAfter sync:');
	console.log('  Doc A users:', usersA.toJSON());
	console.log('  Doc B users:', usersB.toJSON());
	console.log('\n✅ RESULT: Both entries preserved! Root-level maps merge.\n');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('DEMO 2: Nested map.set(key, new Y.Map()) - COLLISION');
console.log(
	'═══════════════════════════════════════════════════════════════\n',
);

{
	const docA = new Y.Doc();
	const docB = new Y.Doc();

	const tablesA = docA.getMap('tables');
	const tablesB = docB.getMap('tables');

	// Both clients create a "posts" table with DIFFERENT data
	// This simulates two users creating the same table concurrently

	// Client A creates posts with a "title" field
	const postsA = new Y.Map();
	postsA.set('schema', new Y.Map([['title', 'text']]));
	postsA.set('rows', new Y.Map([['row-a', 'Hello from A']]));
	tablesA.set('posts', postsA);

	// Client B creates posts with a "content" field and different row
	const postsB = new Y.Map();
	postsB.set('schema', new Y.Map([['content', 'richtext']]));
	postsB.set('rows', new Y.Map([['row-b', 'Hello from B']]));
	tablesB.set('posts', postsB);

	console.log('Before sync:');
	console.log(
		'  Doc A tables.posts:',
		(tablesA.get('posts') as Y.Map<unknown>)?.toJSON(),
	);
	console.log(
		'  Doc B tables.posts:',
		(tablesB.get('posts') as Y.Map<unknown>)?.toJSON(),
	);

	// Sync
	syncDocs(docA, docB);

	console.log('\nAfter sync:');
	console.log(
		'  Doc A tables.posts:',
		(tablesA.get('posts') as Y.Map<unknown>)?.toJSON(),
	);
	console.log(
		'  Doc B tables.posts:',
		(tablesB.get('posts') as Y.Map<unknown>)?.toJSON(),
	);

	// Check what survived
	const postsAfterSync = tablesA.get('posts') as Y.Map<unknown>;
	const schema = postsAfterSync?.get('schema') as Y.Map<unknown>;
	const rows = postsAfterSync?.get('rows') as Y.Map<unknown>;

	const hasTitle = schema?.has('title');
	const hasContent = schema?.has('content');
	const hasRowA = rows?.has('row-a');
	const hasRowB = rows?.has('row-b');

	console.log('\n❌ RESULT: One branch won, other is GONE:');
	console.log(`  - title field: ${hasTitle ? 'EXISTS' : 'LOST'}`);
	console.log(`  - content field: ${hasContent ? 'EXISTS' : 'LOST'}`);
	console.log(`  - row-a: ${hasRowA ? 'EXISTS' : 'LOST'}`);
	console.log(`  - row-b: ${hasRowB ? 'EXISTS' : 'LOST'}`);
	console.log('\n  The losing client\'s entire "posts" table was dropped.\n');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('DEMO 3: Editing INSIDE existing nested map - SAFE');
console.log(
	'═══════════════════════════════════════════════════════════════\n',
);

{
	const docA = new Y.Doc();
	const docB = new Y.Doc();

	// First, establish the structure in both docs via sync
	const tablesA = docA.getMap('tables');
	const posts = new Y.Map();
	posts.set('rows', new Y.Map());
	tablesA.set('posts', posts);

	// Sync so both docs have the same "posts" Y.Map instance
	syncDocs(docA, docB);

	const tablesB = docB.getMap('tables');

	// Now both clients edit INSIDE the existing posts.rows map
	const rowsA = (tablesA.get('posts') as Y.Map<unknown>).get(
		'rows',
	) as Y.Map<unknown>;
	const rowsB = (tablesB.get('posts') as Y.Map<unknown>).get(
		'rows',
	) as Y.Map<unknown>;

	rowsA.set('row-a', 'Data from A');
	rowsB.set('row-b', 'Data from B');

	console.log('Before sync (editing inside existing nested map):');
	console.log('  Doc A posts.rows:', rowsA.toJSON());
	console.log('  Doc B posts.rows:', rowsB.toJSON());

	// Sync
	syncDocs(docA, docB);

	console.log('\nAfter sync:');
	console.log('  Doc A posts.rows:', rowsA.toJSON());
	console.log('  Doc B posts.rows:', rowsB.toJSON());
	console.log(
		'\n✅ RESULT: Both rows preserved! Edits inside existing types merge.\n',
	);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('DEMO 4: The "if (!has) set" pattern - STILL RACES');
console.log(
	'═══════════════════════════════════════════════════════════════\n',
);

{
	const docA = new Y.Doc();
	const docB = new Y.Doc();

	const tablesA = docA.getMap('tables');
	const tablesB = docB.getMap('tables');

	// Both clients use the "safe" pattern... but both pass the check
	// before either syncs

	// Client A checks and creates
	if (!tablesA.has('posts')) {
		console.log('Client A: posts does not exist, creating...');
		const posts = new Y.Map();
		posts.set('createdBy', 'A');
		posts.set('data', 'A data');
		tablesA.set('posts', posts);
	}

	// Client B checks and creates (before sync!)
	if (!tablesB.has('posts')) {
		console.log('Client B: posts does not exist, creating...');
		const posts = new Y.Map();
		posts.set('createdBy', 'B');
		posts.set('data', 'B data');
		tablesB.set('posts', posts);
	}

	console.log('\nBefore sync:');
	console.log(
		'  Doc A posts:',
		(tablesA.get('posts') as Y.Map<unknown>)?.toJSON(),
	);
	console.log(
		'  Doc B posts:',
		(tablesB.get('posts') as Y.Map<unknown>)?.toJSON(),
	);

	// Sync
	syncDocs(docA, docB);

	console.log('\nAfter sync:');
	console.log(
		'  Doc A posts:',
		(tablesA.get('posts') as Y.Map<unknown>)?.toJSON(),
	);
	console.log(
		'  Doc B posts:',
		(tablesB.get('posts') as Y.Map<unknown>)?.toJSON(),
	);

	const winner = (tablesA.get('posts') as Y.Map<unknown>)?.get('createdBy');
	console.log(
		`\n❌ RESULT: The "if (!has)" check didn't help. Winner: Client ${winner}\n`,
	);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`
✅ SAFE:
   - doc.getMap('name') at root level
   - Edits inside existing shared types
   - Using UUIDs as keys (no collision possible)

❌ UNSAFE (can lose data on concurrent creation):
   - map.set('key', new Y.Map()) when key might collide
   - The "if (!has) set" pattern does NOT prevent this

The key insight: root types are named singletons that merge.
Nested assignments are values that compete for a key.
`);
