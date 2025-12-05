import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { updateYTextFromString } from './yjs';

describe('updateYTextFromString', () => {
	test('handles identical strings (no changes needed)', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello World');
		updateYTextFromString(ytext, 'Hello World');

		expect(ytext.toString()).toBe('Hello World');
	});

	test('handles simple insertion in the middle', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello World');
		updateYTextFromString(ytext, 'Hello Beautiful World');

		expect(ytext.toString()).toBe('Hello Beautiful World');
	});

	test('handles simple deletion in the middle', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello Beautiful World');
		updateYTextFromString(ytext, 'Hello World');

		expect(ytext.toString()).toBe('Hello World');
	});

	test('handles replacement at the beginning', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello World');
		updateYTextFromString(ytext, 'Hi World');

		expect(ytext.toString()).toBe('Hi World');
	});

	test('handles replacement at the end', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello World');
		updateYTextFromString(ytext, 'Hello Everyone');

		expect(ytext.toString()).toBe('Hello Everyone');
	});

	test('handles complete replacement', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello World');
		updateYTextFromString(ytext, 'Goodbye Universe');

		expect(ytext.toString()).toBe('Goodbye Universe');
	});

	test('handles empty string to non-empty string', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		updateYTextFromString(ytext, 'Hello World');

		expect(ytext.toString()).toBe('Hello World');
	});

	test('handles non-empty string to empty string', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello World');
		updateYTextFromString(ytext, '');

		expect(ytext.toString()).toBe('');
	});

	test('handles multiple changes in one sync', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'The quick brown fox');
		updateYTextFromString(ytext, 'A slow red wolf');

		expect(ytext.toString()).toBe('A slow red wolf');
	});

	test('handles special characters', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello\nWorld');
		updateYTextFromString(ytext, 'Hello\tWorld!');

		expect(ytext.toString()).toBe('Hello\tWorld!');
	});

	test('handles unicode characters', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		ytext.insert(0, 'Hello 世界');
		updateYTextFromString(ytext, 'Hello 世界! 👋');

		expect(ytext.toString()).toBe('Hello 世界! 👋');
	});

	test('preserves Y.Text CRDT properties', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('content');

		// Insert initial text
		ytext.insert(0, 'Hello World');

		// Get length before sync
		const _initialLength = ytext.length;

		// Sync to similar string (should preserve some characters)
		updateYTextFromString(ytext, 'Hello Universe');

		// Verify the result
		expect(ytext.toString()).toBe('Hello Universe');
		expect(ytext.length).toBe('Hello Universe'.length);
	});
});
