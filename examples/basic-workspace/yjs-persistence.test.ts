import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createEpicenterClient } from '@epicenter/hq';
import epicenterConfig from './epicenter.config';

let post1Id: string;
let post2Id: string;

test('YJS file is created on first session', async () => {
	console.log('📝 Session 1: Creating initial data...');
	using client = await createEpicenterClient(epicenterConfig);
	const blog = client.blog;

	const { data: post1 } = await blog.createPost({
		title: 'Persistence Test Post',
		content: 'This post should survive across sessions',
		category: 'tech',
	});
	post1Id = post1.id;
	console.log(`   Created post: ${post1Id}`);

	const { data: post2 } = await blog.createPost({
		title: 'Second Test Post',
		content: 'Another post for testing',
		category: 'personal',
	});
	post2Id = post2.id;
	console.log(`   Created post: ${post2Id}`);

	await blog.publishPost({ id: post1Id });
	console.log(`   Published post: ${post1Id}`);

	await blog.addComment({
		postId: post1Id,
		author: 'Alice',
		content: 'Great post!',
	});
	console.log(`   Added comment to post: ${post1Id}`);

	await new Promise((resolve) => setTimeout(resolve, 200));

	expect(existsSync('./.epicenter/blog.yjs')).toBe(true);
	console.log('   ✅ YJS file created at .epicenter/blog.yjs');
	console.log('   Session 1 closed\n');
});

test('data persists across sessions', async () => {
	console.log('🔄 Session 2: Loading from persisted state...');
	using client = await createEpicenterClient(epicenterConfig);
	const blog = client.blog;

	await new Promise((resolve) => setTimeout(resolve, 200));

	const { data: allPosts } = await blog.getPublishedPosts();
	console.log(`   Found ${allPosts.length} published post(s)`);
	expect(allPosts.length).toBeGreaterThan(0);

	const { data: retrievedPost } = await blog.getPost({ id: post1Id });
	expect(retrievedPost).toBeTruthy();
	expect(retrievedPost.title).toBe('Persistence Test Post');
	expect(retrievedPost.publishedAt).toBeTruthy();
	console.log(`   ✅ Post found: ${retrievedPost.title}`);

	const { data: comments } = await blog.getPostComments({ postId: post1Id });
	expect(comments.length).toBeGreaterThan(0);
	console.log(`   ✅ Found ${comments.length} comment(s)`);
	console.log('   Session 2 closed\n');
});

test('updates persist across sessions', async () => {
	console.log('📝 Session 3: Making updates...');
	using client = await createEpicenterClient(epicenterConfig);
	const blog = client.blog;

	await new Promise((resolve) => setTimeout(resolve, 200));

	await blog.incrementViews({ id: post1Id });
	await blog.incrementViews({ id: post1Id });
	console.log(`   Incremented views on post: ${post1Id}`);
	console.log('   Session 3 closed\n');
});

test('updates are persisted after client disposal', async () => {
	console.log('🔄 Session 4: Verifying updates persisted...');
	using client = await createEpicenterClient(epicenterConfig);
	const blog = client.blog;

	await new Promise((resolve) => setTimeout(resolve, 200));

	const { data: finalPost } = await blog.getPost({ id: post1Id });
	expect(finalPost).toBeTruthy();
	expect(finalPost.views).toBe(2);
	console.log(`   ✅ Views: ${finalPost.views}`);
	console.log('   Session 4 closed\n');
});

test('can query all posts after multiple sessions', async () => {
	console.log('🔍 Session 5: Final verification...');
	using client = await createEpicenterClient(epicenterConfig);
	const blog = client.blog;

	await new Promise((resolve) => setTimeout(resolve, 200));

	const { data: allPosts } = await blog.getPublishedPosts();
	expect(allPosts.length).toBeGreaterThan(0);
	console.log(`   ✅ Posts queryable: ${allPosts.length} post(s)\n`);
	console.log('   Session 5 closed\n');

	console.log('✅ All persistence tests passed!');
});
