/**
 * Streaming Struct Count Tests
 *
 * The lazy walk must agree exactly with decodeUpdateV2 on every shape,
 * because the authority refuses candidates from its count before apply. This
 * conformance suite is the tripwire for the patched deep import across @y/y
 * upgrades.
 */
import { expect, test } from 'bun:test';
import * as Y from '@y/y';
import { updateStructCountExceeds } from './update-struct-count.js';

function decodedCount(update: Uint8Array): number {
	return Y.decodeUpdateV2(update).structs.length;
}

function exactCount(update: Uint8Array): number {
	let low = 0;
	let high = 1;
	while (updateStructCountExceeds(update, high)) high *= 2;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (updateStructCountExceeds(update, mid)) low = mid + 1;
		else high = mid;
	}
	return low;
}

test('the streaming count matches decodeUpdateV2 across shapes', () => {
	const shapes: Uint8Array[] = [];

	const benign = new Y.Doc();
	benign.get('t').insert(0, 'x'.repeat(50_000));
	shapes.push(Y.encodeStateAsUpdateV2(benign));

	const hostile = new Y.Doc();
	hostile.transact(() => {
		for (let i = 0; i < 5_000; i++) hostile.get('t').insert(0, 'z');
	});
	shapes.push(Y.encodeStateAsUpdateV2(hostile));

	const deleteHeavy = new Y.Doc();
	deleteHeavy.get('t').insert(0, 'y'.repeat(10_000));
	for (let i = 0; i < 500; i++) deleteHeavy.get('t').delete(i * 9, 3);
	shapes.push(Y.encodeStateAsUpdateV2(deleteHeavy));

	const merged = Y.mergeUpdatesV2(
		shapes.slice(0, 2) as Uint8Array<ArrayBuffer>[],
	);
	shapes.push(merged);

	for (const update of shapes) {
		expect(exactCount(update)).toBe(decodedCount(update));
	}
	benign.destroy();
	hostile.destroy();
	deleteHeavy.destroy();
});

test('a malformed update throws instead of counting', () => {
	expect(() =>
		updateStructCountExceeds(new Uint8Array([9, 9, 9]), 10),
	).toThrow();
});

test('the walk aborts at the limit without reading the remainder', () => {
	const dense = new Y.Doc();
	dense.transact(() => {
		for (let i = 0; i < 20_000; i++) dense.get('t').insert(0, 'z');
	});
	const update = Y.encodeStateAsUpdateV2(dense);
	expect(updateStructCountExceeds(update, 100)).toBe(true);
	expect(updateStructCountExceeds(update, 20_000)).toBe(false);
	dense.destroy();
});
