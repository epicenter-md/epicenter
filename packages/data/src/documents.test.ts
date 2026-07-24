/**
 * Row-Document Publication Obligation Tests
 *
 * Verifies the durable authority-publication record that ADR-0171/0174 attach
 * to locally authored document work: local appends advance the obligation in
 * the append transaction, authority-accepted installs never mint one, freeze
 * produces an immutable digest-bound retry image, settle requires the exact
 * digest, park removes an address from the drain until a later local edit
 * re-arms it, and row deletion removes chain and obligation together.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import {
	acceptedDocumentOrigin,
	applyRowDocumentUpdate,
	createDocumentRuntime,
	type DocumentAddress,
} from './documents.js';
import { openReplica } from './replica/index.js';

const NOTES_KEY = 'so.epicenter.tests.notes';

function rowId(seed: string): string {
	return seed
		.replaceAll(/[^a-z0-9]/g, '')
		.padEnd(24, '0')
		.slice(0, 24);
}

function address(seed: string): DocumentAddress {
	return { key: NOTES_KEY, rowId: rowId(seed) };
}

function setup() {
	const rawDatabase = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(rawDatabase);
	const replica = expectOk(openReplica({ database }));
	const documents = createDocumentRuntime({ database, replica });
	function createRow(target: DocumentAddress): void {
		expectOk(
			replica.write({
				kind: 'create',
				key: target.key,
				rowId: target.rowId,
				fields: { title: 'owned' },
			}),
		);
	}
	function chainLength(target: DocumentAddress): number {
		return (
			database.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM document_updates
				 WHERE qualified_key = ? AND row_id = ?`,
				[target.key, target.rowId],
			)[0]?.count ?? 0
		);
	}
	return { rawDatabase, database, replica, documents, createRow, chainLength };
}

function encodeText(text: string): Uint8Array {
	const authored = new Y.Doc();
	try {
		authored.get('content').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(authored));
	} finally {
		authored.destroy();
	}
}

test('local edits advance the obligation; accepted installs never do', async () => {
	const context = setup();
	try {
		const target = address('provenance');
		context.createRow(target);
		const document = await context.documents.open(target);

		document.transact(() => document.get('content').insert(0, 'local'));
		expect(context.documents.publication.status(target)).toEqual({
			revision: 1,
			acceptedRevision: 0,
			parkedRevision: undefined,
			inflightDigest: undefined,
		});
		expect(context.documents.publication.listDirty()).toEqual([target]);

		applyRowDocumentUpdate(
			document,
			encodeText('remote'),
			acceptedDocumentOrigin,
		);
		// The accepted bytes are durably persisted, yet the obligation is
		// untouched: authority state never republishes itself.
		expect(context.chainLength(target)).toBe(2);
		expect(context.documents.publication.status(target)?.revision).toBe(1);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('an accepted-only document never enters the drain', async () => {
	const context = setup();
	try {
		const target = address('accepted-only');
		context.createRow(target);
		const document = await context.documents.open(target);
		applyRowDocumentUpdate(
			document,
			encodeText('hydrated from authority'),
			acceptedDocumentOrigin,
		);
		expect(context.chainLength(target)).toBe(1);
		expect(context.documents.publication.status(target)).toBeUndefined();
		expect(context.documents.publication.listDirty()).toEqual([]);
		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('freeze produces one immutable digest-bound retry image', async () => {
	const context = setup();
	try {
		const target = address('freeze');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'frozen'));

		const image = context.documents.publication.freeze(target);
		expect(image).toBeDefined();
		expect(image?.revision).toBe(1);
		expect(image?.digest).toMatch(/^[0-9a-f]{64}$/);

		// A lost response retries the exact same bytes.
		const retried = context.documents.publication.freeze(target);
		expect(retried?.digest).toBe(image?.digest);
		expect(retried?.update).toEqual(image?.update);

		// A racing local edit lands as a newer revision without touching the
		// frozen image.
		document.transact(() => document.get('content').insert(6, ' race'));
		const during = context.documents.publication.freeze(target);
		expect(during?.digest).toBe(image?.digest);
		expect(during?.revision).toBe(1);
		expect(context.documents.publication.status(target)?.revision).toBe(2);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('settle requires the exact digest and never clears newer local work', async () => {
	const context = setup();
	try {
		const target = address('settle');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'one'));
		const image = context.documents.publication.freeze(target);
		if (image === undefined) throw new Error('expected a frozen image');

		// A foreign receipt changes nothing.
		context.documents.publication.settle(target, { digest: 'not-the-digest' });
		expect(context.documents.publication.status(target)?.inflightDigest).toBe(
			image.digest,
		);

		// A racing edit after the freeze keeps the address dirty through the
		// matching receipt: acceptance proves revision 1, not revision 2.
		document.transact(() => document.get('content').insert(3, ' two'));
		context.documents.publication.settle(target, { digest: image.digest });
		expect(context.documents.publication.status(target)).toEqual({
			revision: 2,
			acceptedRevision: 1,
			parkedRevision: undefined,
			inflightDigest: undefined,
		});
		expect(context.documents.publication.listDirty()).toEqual([target]);

		// Publishing the newer revision settles it completely.
		const next = context.documents.publication.freeze(target);
		if (next === undefined) throw new Error('expected a second image');
		expect(next.revision).toBe(2);
		context.documents.publication.settle(target, { digest: next.digest });
		expect(context.documents.publication.listDirty()).toEqual([]);
		expect(context.documents.publication.status(target)?.acceptedRevision).toBe(
			2,
		);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('park removes the address from the drain until a later local edit', async () => {
	const context = setup();
	try {
		const target = address('parked');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'too big'));
		context.documents.publication.freeze(target);

		context.documents.publication.park(target);
		expect(context.documents.publication.listDirty()).toEqual([]);
		expect(context.documents.publication.status(target)).toEqual({
			revision: 1,
			acceptedRevision: 0,
			parkedRevision: 1,
			inflightDigest: undefined,
		});
		// Parked is not synchronized: the obligation record survives.
		expect(context.documents.publication.freeze(target)).toBeUndefined();

		// A later local edit advances past the parked revision and re-arms.
		document.transact(() => document.get('content').insert(0, 'shrunk'));
		expect(context.documents.publication.listDirty()).toEqual([target]);
		expect(context.documents.publication.freeze(target)?.revision).toBe(2);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('clearInflight drops the retry image but keeps the address dirty', async () => {
	const context = setup();
	try {
		const target = address('clear-inflight');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'owed'));
		const image = context.documents.publication.freeze(target);

		context.documents.publication.clearInflight(target);
		expect(
			context.documents.publication.status(target)?.inflightDigest,
		).toBeUndefined();
		expect(context.documents.publication.listDirty()).toEqual([target]);

		// A later settle against the dropped image is inert.
		context.documents.publication.settle(target, {
			digest: image?.digest ?? '',
		});
		expect(context.documents.publication.listDirty()).toEqual([target]);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('row deletion removes the obligation in the same transaction as the chain', async () => {
	const context = setup();
	try {
		const doomed = address('doomed');
		const kept = address('kept');
		context.createRow(doomed);
		context.createRow(kept);
		for (const target of [doomed, kept]) {
			const document = await context.documents.open(target);
			document.transact(() => document.get('content').insert(0, 'owed'));
			await document[Symbol.asyncDispose]();
		}

		expectOk(
			context.replica.write({
				kind: 'delete',
				key: doomed.key,
				rowId: doomed.rowId,
			}),
		);
		expect(context.chainLength(doomed)).toBe(0);
		expect(context.documents.publication.status(doomed)).toBeUndefined();
		expect(context.documents.publication.listDirty()).toEqual([kept]);
	} finally {
		context.rawDatabase.close();
	}
});

test('compaction preserves the frozen retry image and the obligation record', async () => {
	const context = setup();
	try {
		const target = address('compact-inflight');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'a'));
		const image = context.documents.publication.freeze(target);
		if (image === undefined) throw new Error('expected a frozen image');

		// Drive the chain across the compaction threshold while the image is
		// in flight.
		for (let index = 0; index < 63; index += 1) {
			document.transact(() =>
				document.get('content').insert(document.get('content').length, 'b'),
			);
		}
		expect(context.chainLength(target)).toBe(1);
		const retried = context.documents.publication.freeze(target);
		expect(retried?.digest).toBe(image.digest);
		expect(retried?.revision).toBe(1);
		expect(context.documents.publication.status(target)?.revision).toBe(64);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});
