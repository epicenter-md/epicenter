import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEpicenterClient } from '@epicenter/hq';
import epicenterConfig from './epicenter.config';

test('markdown file edits sync back to YJS', async () => {
	console.log('🚀 Testing bidirectional markdown sync...');

	using client = await createEpicenterClient(epicenterConfig);
	const blog = client.blog;

	// Create a test post
	console.log('📝 Creating test post...');
	const { data: post } = await blog.createPost({
		title: 'Bidirectional Sync Test',
		content: 'Original content',
		category: 'tech',
	});
	console.log(`   Created post with ID: ${post.id}`);

	// Wait for markdown file to be created
	await new Promise((resolve) => setTimeout(resolve, 300));

	// Verify markdown file exists
	const markdownPath = join(
		process.cwd(),
		'.data/content/posts',
		`${post.id}.md`,
	);
	const fileExists = (() => {
		try {
			readFileSync(markdownPath, 'utf-8');
			return true;
		} catch {
			return false;
		}
	})();
	expect(fileExists).toBe(true);
	console.log(`   ✅ Markdown file created: ${markdownPath}`);

	// Read the markdown file
	const originalContent = readFileSync(markdownPath, 'utf-8');
	console.log('   Original markdown content read');

	// Edit the markdown file programmatically
	console.log('✏️  Editing markdown file programmatically...');
	const updatedContent = originalContent
		.replace('title: Bidirectional Sync Test', 'title: Updated Title')
		.replace('content: Original content', 'content: Updated content via file');
	await Bun.write(markdownPath, updatedContent);
	console.log('   ✅ Markdown file updated');

	// Wait for file watcher to process the change
	console.log('⏳ Waiting for file watcher to process changes...');
	await new Promise((resolve) => setTimeout(resolve, 500));

	// Query the post to verify changes were synced
	console.log('🔍 Querying post to verify changes synced...');
	const { data: updatedPost } = await blog.getPost({ id: post.id });

	expect(updatedPost).toBeTruthy();
	expect(updatedPost.title).toBe('Updated Title');
	expect(updatedPost.content).toBe('Updated content via file');

	console.log('   Original post:');
	console.log(`      Title: "${post.title}"`);
	console.log(`      Content: "${post.content}"`);
	console.log('   Updated post (from markdown edit):');
	console.log(`      Title: "${updatedPost.title}"`);
	console.log(`      Content: "${updatedPost.content}"`);

	console.log(
		'\n✅ Bidirectional sync is working! Changes from markdown file synced to YJS.',
	);
});
