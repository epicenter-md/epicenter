/**
 * Directory Workspace Tests
 *
 * Two invariants the capability plane depends on (ADR-0079):
 *
 *  - noSecret: the boxes directory carries ADDRESSES ONLY. There is no token /
 *    secret / bearer column, and none must ever leak into the serialized doc.
 *    Asserted against the actual Yjs serialization (write -> encode -> apply ->
 *    inspect), not just the TypeScript type, so a future column that smuggled a
 *    secret would fail here even if the type looked innocent.
 *
 *  - sync round-trip: a box registered on one device appears on another. This
 *    is the whole point of riding the sync plane for discovery: learn the
 *    address once, reach the box directly from every device.
 */

import { InstantString } from '@epicenter/field';
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { type Box, directoryWorkspace, generateBoxId } from './index.js';

/** A benign sample box: values chosen so no field VALUE trips the secret scan. */
const sampleBox = (): Box => ({
	id: generateBoxId(),
	label: 'Mac Studio',
	baseUrl: 'https://mac-studio.tail1234.ts.net',
	createdAt: InstantString.fromDate(new Date('2026-06-30T12:00:00.000Z')),
});

/** Recursively collect every object key reachable in a JSON value. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectKeys(item, into);
	} else if (value !== null && typeof value === 'object') {
		for (const [key, child] of Object.entries(value)) {
			into.add(key);
			collectKeys(child, into);
		}
	}
	return into;
}

describe('directoryWorkspace', () => {
	test('boxes schema declares addresses only (id, label, baseUrl, createdAt)', () => {
		using ws = directoryWorkspace.create();
		const columns = Object.keys(ws.tables.boxes.schema.properties).sort();
		expect(columns).toEqual(['baseUrl', 'createdAt', 'id', 'label']);
	});

	test('noSecret: the serialized doc carries no token/secret-shaped key', () => {
		using writer = directoryWorkspace.create();
		const { error } = writer.tables.boxes.set(sampleBox());
		expect(error).toBeNull();

		// Round-trip through real Yjs serialization. Inspect a second instance
		// whose stores are materialized, so `toJSON()` exposes the RAW persisted
		// structure (row values plus the library `_v` stamp), not the codec-
		// stripped row a point read returns.
		using reader = directoryWorkspace.create();
		Y.applyUpdate(reader.ydoc, Y.encodeStateAsUpdate(writer.ydoc));
		const serialized = reader.ydoc.toJSON();
		const keys = collectKeys(serialized);

		const forbidden = /token|secret|bearer|api[-_]?key|password|credential|private[-_]?key/i;
		const offenders = [...keys].filter((k) => forbidden.test(k));
		expect(offenders).toEqual([]);
		// And the address IS present, proving we inspected real data, not an empty doc.
		expect(JSON.stringify(serialized)).toContain('mac-studio.tail1234.ts.net');
	});

	test('sync round-trip: a box written on device A appears on device B', () => {
		using deviceA = directoryWorkspace.create();
		using deviceB = directoryWorkspace.create();

		const box = sampleBox();
		const { error: writeError } = deviceA.tables.boxes.set(box);
		expect(writeError).toBeNull();

		// The binary update path: exactly how the sync plane moves the row.
		Y.applyUpdate(deviceB.ydoc, Y.encodeStateAsUpdate(deviceA.ydoc));

		const { data: seen, error: readError } = deviceB.tables.boxes.get(box.id);
		expect(readError).toBeNull();
		expect(seen).toEqual(box);
	});
});
