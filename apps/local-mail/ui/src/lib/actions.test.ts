import { describe, expect, test } from 'bun:test';
import {
	invert,
	isReversible,
	planLabel,
	planToggle,
	type TriageAction,
} from './actions';

describe('planToggle', () => {
	test('inbox toggles on presence of INBOX', () => {
		expect(planToggle(['INBOX', 'UNREAD'], 'inbox')).toEqual({
			label: 'Archived',
			addLabels: [],
			removeLabels: ['INBOX'],
		});
		expect(planToggle(['UNREAD'], 'inbox')).toEqual({
			label: 'Moved to inbox',
			addLabels: ['INBOX'],
			removeLabels: [],
		});
	});

	test('read toggles on presence of UNREAD', () => {
		expect(planToggle(['UNREAD'], 'read')).toEqual({
			label: 'Marked read',
			addLabels: [],
			removeLabels: ['UNREAD'],
		});
		expect(planToggle(['INBOX'], 'read')).toEqual({
			label: 'Marked unread',
			addLabels: ['UNREAD'],
			removeLabels: [],
		});
	});

	test('star toggles on presence of STARRED', () => {
		expect(planToggle(['STARRED'], 'star')).toEqual({
			label: 'Unstarred',
			addLabels: [],
			removeLabels: ['STARRED'],
		});
		expect(planToggle([], 'star')).toEqual({
			label: 'Starred',
			addLabels: ['STARRED'],
			removeLabels: [],
		});
	});
});

describe('planLabel', () => {
	test('removes a present label, adds an absent one', () => {
		expect(planLabel('Label_1', 'Receipts', true)).toEqual({
			label: 'Removed Receipts',
			addLabels: [],
			removeLabels: ['Label_1'],
		});
		expect(planLabel('Label_1', 'Receipts', false)).toEqual({
			label: 'Added Receipts',
			addLabels: ['Label_1'],
			removeLabels: [],
		});
	});
});

describe('invert', () => {
	test('is a true inverse: swaps add and remove', () => {
		const archive = planToggle(['INBOX'], 'inbox');
		const undo = invert(archive);
		expect(undo.addLabels).toEqual(['INBOX']);
		expect(undo.removeLabels).toEqual([]);
		// Inverting twice returns the original payload.
		expect(invert(undo)).toEqual(archive);
	});
});

describe('isReversible', () => {
	test('true when any label is touched, false for a no-op', () => {
		expect(isReversible(planToggle(['INBOX'], 'inbox'))).toBe(true);
		const noop: TriageAction = { label: 'x', addLabels: [], removeLabels: [] };
		expect(isReversible(noop)).toBe(false);
	});
});
