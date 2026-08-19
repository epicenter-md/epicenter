/**
 * What the overlay promises the two callers that need it: the id sets SQL
 * filters by, and the label set a row displays.
 */

import { describe, expect, test } from 'bun:test';
import type { LabelIntent } from './intent.ts';
import { overlayOf } from './overlay.ts';

const intent = (
	messageId: string,
	labelId: string,
	want: boolean,
	seq = 1,
): LabelIntent => ({ messageId, labelId, want, seq });

describe('an empty overlay', () => {
	test('degenerates every read to Gmail facts', () => {
		const overlay = overlayOf([]);
		expect(overlay.isEmpty).toBe(true);
		expect(overlay.addedTo('INBOX')).toEqual([]);
		expect(overlay.removedFrom('INBOX')).toEqual([]);
		expect(overlay.effectiveLabels('m1', ['INBOX', 'UNREAD'])).toEqual([
			'INBOX',
			'UNREAD',
		]);
	});

	test('does not alias the caller’s array', () => {
		const mirrored = ['INBOX'];
		const out = overlayOf([]).effectiveLabels('m1', mirrored);
		out.push('STARRED');
		expect(mirrored).toEqual(['INBOX']);
	});
});

describe('the id sets SQL filters by', () => {
	test('separate assertions on from assertions off, per label', () => {
		const overlay = overlayOf([
			intent('m1', 'INBOX', false),
			intent('m2', 'INBOX', true),
			intent('m3', 'INBOX', false),
			intent('m4', 'STARRED', true),
		]);
		expect(overlay.removedFrom('INBOX')).toEqual(['m1', 'm3']);
		expect(overlay.addedTo('INBOX')).toEqual(['m2']);
		expect(overlay.addedTo('STARRED')).toEqual(['m4']);
		expect(overlay.removedFrom('STARRED')).toEqual([]);
	});

	test('an untouched label has no opinion either way', () => {
		const overlay = overlayOf([intent('m1', 'INBOX', false)]);
		expect(overlay.addedTo('TRASH')).toEqual([]);
		expect(overlay.removedFrom('TRASH')).toEqual([]);
	});

	// The case an overlay applied after paging can never handle: this message
	// does not carry the label in the mirror at all, so no amount of decorating
	// the returned rows would put it on the page. SQL has to know about it.
	test('a message asserted INTO a label it was never mirrored with is listed', () => {
		const overlay = overlayOf([intent('m9', 'INBOX', true)]);
		expect(overlay.addedTo('INBOX')).toEqual(['m9']);
		expect(overlay.effectiveLabels('m9', ['ARCHIVE'])).toEqual([
			'ARCHIVE',
			'INBOX',
		]);
	});
});

describe('the label set a row displays', () => {
	test('drops what was asserted off and appends what was asserted on', () => {
		const overlay = overlayOf([
			intent('m1', 'INBOX', false),
			intent('m1', 'STARRED', true),
		]);
		expect(overlay.effectiveLabels('m1', ['INBOX', 'UNREAD'])).toEqual([
			'UNREAD',
			'STARRED',
		]);
	});

	test('is partial: a label nobody touched is folded normally', () => {
		const overlay = overlayOf([intent('m1', 'STARRED', true)]);
		expect(overlay.effectiveLabels('m1', ['INBOX', 'UNREAD'])).toEqual([
			'INBOX',
			'UNREAD',
			'STARRED',
		]);
	});

	test('asserting a label the mirror already carries is not a duplicate', () => {
		const overlay = overlayOf([intent('m1', 'INBOX', true)]);
		expect(overlay.effectiveLabels('m1', ['INBOX'])).toEqual(['INBOX']);
	});

	test('mirrored order is preserved and additions come last', () => {
		const overlay = overlayOf([intent('m1', 'STARRED', true)]);
		expect(
			overlay.effectiveLabels('m1', ['INBOX', 'UNREAD', 'CATEGORY_SOCIAL']),
		).toEqual(['INBOX', 'UNREAD', 'CATEGORY_SOCIAL', 'STARRED']);
	});

	test('one message’s opinions never reach another', () => {
		const overlay = overlayOf([intent('m1', 'INBOX', false)]);
		expect(overlay.effectiveLabels('m2', ['INBOX'])).toEqual(['INBOX']);
	});

	// `assert` overwrites a pair rather than appending, so the store cannot hold
	// two rows for one pair. If it ever did, last write wins, which matches the
	// primary key's own semantics.
	test('the last opinion on a pair wins', () => {
		const overlay = overlayOf([
			intent('m1', 'INBOX', true, 1),
			intent('m1', 'INBOX', false, 2),
		]);
		expect(overlay.effectiveLabels('m1', ['INBOX'])).toEqual([]);
	});
});
