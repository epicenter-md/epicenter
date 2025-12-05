import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { boolean, id, integer, tags, text, ytext } from '../schema';
import { createEpicenterDb } from './core';

describe('createEpicenterDb', () => {
	test('should create and retrieve rows correctly', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createEpicenterDb(ydoc, {
			posts: {
				id: id(),
				title: text(),
				view_count: integer(),
				published: boolean(),
			},
		});

		// Create a row
		doc.posts.insert({
			id: '1',
			title: 'Test Post',
			view_count: 0,
			published: false,
		});

		// Retrieve the row
		const result = doc.posts.get({ id: '1' });
		expect(result).not.toBeNull();
		if (result?.data) {
			expect(result.data.title).toBe('Test Post');
			expect(result.data.view_count).toBe(0);
			expect(result.data.published).toBe(false);
		}
	});

	test('should handle batch operations', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createEpicenterDb(ydoc, {
			posts: {
				id: id(),
				title: text(),
				view_count: integer(),
				published: boolean(),
			},
		});

		// Create multiple rows
		const { error: insertError } = doc.posts.insertMany({
			rows: [
				{ id: '1', title: 'Post 1', view_count: 10, published: true },
				{ id: '2', title: 'Post 2', view_count: 20, published: false },
			],
		});
		expect(insertError).toBeNull();

		// Retrieve and verify rows
		const row1 = doc.posts.get({ id: '1' });
		const row2 = doc.posts.get({ id: '2' });
		expect(row1).not.toBeNull();
		expect(row2).not.toBeNull();
		if (row1?.data) {
			expect(row1.data.title).toBe('Post 1');
		}
		if (row2?.data) {
			expect(row2.data.title).toBe('Post 2');
		}
	});

	test('should filter and find rows correctly', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createEpicenterDb(ydoc, {
			posts: {
				id: id(),
				title: text(),
				view_count: integer(),
				published: boolean(),
			},
		});

		doc.posts.insertMany({
			rows: [
				{ id: '1', title: 'Post 1', view_count: 10, published: true },
				{ id: '2', title: 'Post 2', view_count: 20, published: false },
				{ id: '3', title: 'Post 3', view_count: 30, published: true },
			],
		});

		// Filter published posts
		const publishedPosts = doc.posts.filter((post) => post.published);
		expect(publishedPosts).toHaveLength(2);

		// Find first unpublished post
		const firstDraft = doc.posts.find((post) => !post.published);
		expect(firstDraft).not.toBeNull();
		if (firstDraft) {
			expect(firstDraft.id).toBe('2');
		}
	});

	test('should return not-found status for non-existent rows', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createEpicenterDb(ydoc, {
			posts: {
				id: id(),
				title: text(),
				view_count: integer(),
				published: boolean(),
			},
		});

		// Test get() with non-existent id
		const getResult = doc.posts.get({ id: 'non-existent' });
		expect(getResult).toBeNull();

		// Test find() with no matches
		const findResult = doc.posts.find((post) => post.id === 'non-existent');
		expect(findResult).toBeNull();
	});

	test('should store and retrieve Y.js types correctly', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createEpicenterDb(ydoc, {
			posts: {
				id: id(),
				title: ytext(),
				tags: tags({ options: ['typescript', 'javascript', 'python'] }),
			},
		});

		// Insert with plain strings and arrays (the documented API)
		doc.posts.insert({
			id: '1',
			title: 'Hello World',
			tags: ['typescript', 'javascript'],
		});

		// Get returns Y.js objects
		const result1 = doc.posts.get({ id: '1' });
		expect(result1).not.toBeNull();
		if (result1?.data) {
			expect(result1.data.title).toBeInstanceOf(Y.Text);
			expect(result1.data.tags).toBeInstanceOf(Y.Array);
			expect(result1.data.title.toString()).toBe('Hello World');
			expect(result1.data.tags.toArray()).toEqual(['typescript', 'javascript']);
		}

		// Insert another post
		doc.posts.insert({
			id: '2',
			title: 'Second Post',
			tags: ['python'],
		});

		// getAll returns Y.js objects
		const rows = doc.posts.getAll();
		expect(rows).toHaveLength(2);
		expect(rows[0].title).toBeInstanceOf(Y.Text);
		expect(rows[0].tags).toBeInstanceOf(Y.Array);
		expect(rows[0].title.toString()).toBe('Hello World');
		expect(rows[1].title.toString()).toBe('Second Post');
	});
});
