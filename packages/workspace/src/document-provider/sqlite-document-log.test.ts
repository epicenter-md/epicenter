/**
 * SQLite Document Log Tests
 *
 * Verifies owner-side Yjs 14 update-log semantics: transactional append
 * admission with row liveness, bounded fresh-document compaction, capture,
 * and composable durable deletion.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	isStorageUpgradeRequiredError,
	type SqliteDatabase,
} from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { sha256HexBytes } from '@epicenter/row-sync';
import * as Y from '@y/y';
import type { RowAddress } from './persistence.js';
import {
	createSqliteDocumentLog,
	inspectSqliteDocumentLogSchema,
	isDocumentRowAbsentError,
} from './sqlite-document-log.js';

const LOG_TABLE = 'workspace_document_updates';

function address(rowId: string): RowAddress {
	return { table: 'notes', rowId };
}

function setup({
	compactionThreshold,
	isRowLive = () => true,
}: {
	compactionThreshold?: number;
	isRowLive?: (address: RowAddress) => boolean;
} = {}) {
	const sqlite = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(sqlite);
	return {
		sqlite,
		database,
		log: createSqliteDocumentLog({
			database,
			isRowLive,
			...(compactionThreshold === undefined ? {} : { compactionThreshold }),
		}),
	};
}

function encodeText(text: string): Uint8Array {
	const document = new Y.Doc();
	try {
		document.get('editor').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

function decodeText(parts: readonly Uint8Array[]): string {
	const document = new Y.Doc();
	try {
		for (const part of parts) Y.applyUpdateV2(document, part);
		return document.get('editor').toString();
	} finally {
		document.destroy();
	}
}

function countUpdates(database: SqliteDatabase, target: RowAddress): number {
	return (
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM ${LOG_TABLE}
			 WHERE table_name = ? AND row_id = ?`,
			[target.table, target.rowId],
		)[0]?.count ?? 0
	);
}

test('partial document schema refuses without repair', () => {
	const sqlite = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(sqlite);
	try {
		database.run(
			`CREATE TABLE ${LOG_TABLE} (
				sequence INTEGER PRIMARY KEY,
				sentinel TEXT NOT NULL
			)`,
		);
		database.run(`INSERT INTO ${LOG_TABLE} VALUES (1, 'preserved')`);

		let failure: unknown;
		try {
			inspectSqliteDocumentLogSchema(database);
		} catch (cause) {
			failure = cause;
		}
		expect(isStorageUpgradeRequiredError(failure)).toBe(true);
		expect(
			database.all<{ sentinel: string }>(`SELECT sentinel FROM ${LOG_TABLE}`),
		).toEqual([{ sentinel: 'preserved' }]);
		expect(
			database.all<{ name: string }>(
				"SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'workspace_document_updates_address'",
			),
		).toEqual([]);
	} finally {
		sqlite.close();
	}
});

test('append then load replays updates in order across reopen', () => {
	const context = setup();
	try {
		context.log.append(address('written'), encodeText('durable value'));
		expect(decodeText(context.log.load(address('written')))).toBe(
			'durable value',
		);
		expect(context.log.load(address('empty'))).toEqual([]);

		const reopened = createSqliteDocumentLog({
			database: context.database,
			isRowLive: () => true,
		});
		expect(decodeText(reopened.load(address('written')))).toBe('durable value');
	} finally {
		context.sqlite.close();
	}
});

test('append refuses an absent row with the named address-scoped error', () => {
	const live = new Set(['alive']);
	const context = setup({ isRowLive: ({ rowId }) => live.has(rowId) });
	try {
		context.log.append(address('alive'), encodeText('kept'));
		let refusal: unknown;
		try {
			context.log.append(address('deleted'), encodeText('dropped'));
		} catch (cause) {
			refusal = cause;
		}
		expect(isDocumentRowAbsentError(refusal)).toBe(true);
		expect(countUpdates(context.database, address('deleted'))).toBe(0);

		// The refusal is address-scoped: the log stays healthy for live rows.
		context.log.append(address('alive'), encodeText('still kept'));
		expect(context.log.load(address('alive'))).toHaveLength(2);
	} finally {
		context.sqlite.close();
	}
});

test('liveness is read inside the append transaction', () => {
	const live = new Set(['racer']);
	const context = setup({
		isRowLive: ({ rowId }) => live.has(rowId),
	});
	try {
		context.log.append(address('racer'), encodeText('before deletion'));
		// The row dies between the renderer capturing the update and the owner
		// admitting it; the same-transaction read refuses the late append.
		live.delete('racer');
		expect(() =>
			context.log.append(address('racer'), encodeText('late append')),
		).toThrow('absent row');
		expect(decodeText(context.log.load(address('racer')))).toBe(
			'before deletion',
		);
	} finally {
		context.sqlite.close();
	}
});

test('bounded compaction replaces the covered prefix with one compact update', () => {
	const context = setup({ compactionThreshold: 3 });
	try {
		const shared = new Y.Doc();
		try {
			const target = address('compacted');
			for (const character of ['a', 'b', 'c']) {
				shared.get('editor').insert(shared.get('editor').length, character);
				context.log.append(
					target,
					new Uint8Array(Y.encodeStateAsUpdateV2(shared)),
				);
			}
			expect(countUpdates(context.database, target)).toBe(1);
			expect(decodeText(context.log.load(target))).toBe('abc');

			// Replacement content compacts back down instead of accreting.
			const replaced = context.log.capture(target);
			expect(replaced).toBeDefined();
			expect(replaced!.byteLength).toBeLessThan(1024);
		} finally {
			shared.destroy();
		}
	} finally {
		context.sqlite.close();
	}
});

test('capture folds durable updates and reports absence as undefined', () => {
	const context = setup();
	try {
		expect(context.log.capture(address('missing'))).toBeUndefined();
		context.log.append(address('captured'), encodeText('captured value'));
		const bytes = context.log.capture(address('captured'));
		expect(decodeText([bytes!])).toBe('captured value');
	} finally {
		context.sqlite.close();
	}
});

test('deleteRows composes into a caller transaction with scalar death', () => {
	const context = setup();
	try {
		context.database.run(
			'CREATE TABLE rows (table_key TEXT, row_id TEXT, PRIMARY KEY(table_key, row_id))',
		);
		context.database.run("INSERT INTO rows VALUES ('notes', 'doomed')");
		context.log.append(address('doomed'), encodeText('to remove'));
		context.log.append(address('survivor'), encodeText('to keep'));

		let failedOnce = false;
		try {
			context.database.transaction(() => {
				context.database.run(
					"DELETE FROM rows WHERE table_key = 'notes' AND row_id = 'doomed'",
				);
				context.log.deleteRows([address('doomed')]);
				throw new Error('injected crash before commit');
			});
		} catch {
			failedOnce = true;
		}
		expect(failedOnce).toBe(true);
		// Scalar and document deletion rolled back together.
		expect(countUpdates(context.database, address('doomed'))).toBe(1);

		context.database.transaction(() => {
			context.database.run(
				"DELETE FROM rows WHERE table_key = 'notes' AND row_id = 'doomed'",
			);
			context.log.deleteRows([address('doomed')]);
		});
		expect(countUpdates(context.database, address('doomed'))).toBe(0);
		expect(decodeText(context.log.load(address('survivor')))).toBe('to keep');
	} finally {
		context.sqlite.close();
	}
});

test('deleteAllRows clears every address inside the caller transaction', () => {
	const context = setup();
	try {
		context.log.append(address('one'), encodeText('1'));
		context.log.append(address('two'), encodeText('2'));
		context.database.transaction(() => {
			context.log.deleteAllRows();
		});
		expect(context.log.load(address('one'))).toEqual([]);
		expect(context.log.load(address('two'))).toEqual([]);
	} finally {
		context.sqlite.close();
	}
});

test('deleted rows cannot be resurrected by a late append', () => {
	const live = new Set(['victim']);
	const context = setup({ isRowLive: ({ rowId }) => live.has(rowId) });
	try {
		context.log.append(address('victim'), encodeText('content'));
		context.database.transaction(() => {
			live.delete('victim');
			context.log.deleteRows([address('victim')]);
		});
		expect(() =>
			context.log.append(address('victim'), encodeText('late')),
		).toThrow('absent row');
		expect(context.log.capture(address('victim'))).toBeUndefined();
	} finally {
		context.sqlite.close();
	}
});

test('corrupt updates poison the log at replay and every later operation', () => {
	const context = setup();
	try {
		context.database.run(
			`INSERT INTO ${LOG_TABLE}(table_name, row_id, update_bytes)
			 VALUES (?, ?, ?)`,
			['notes', 'corrupt', new Uint8Array([255])],
		);
		// Load hands raw bytes to the renderer, which fails closed at apply;
		// owner-side replay (capture, compaction) fails closed here.
		expect(() => context.log.capture(address('corrupt'))).toThrow();
		expect(() => context.log.load(address('healthy'))).toThrow();
		expect(() =>
			context.log.append(address('healthy'), encodeText('refused')),
		).toThrow();
		expect(() => context.log.capture(address('healthy'))).toThrow();
	} finally {
		context.sqlite.close();
	}
});

// ============================================================================
// Publication obligation (ADR-0171/0174)
// ============================================================================

test('local append records a durable obligation; accepted append records none', () => {
	const context = setup();
	try {
		context.log.append(address('authored'), encodeText('mine'), 'local');
		expect(context.log.publication.status(address('authored'))).toEqual({
			revision: 1,
			acceptedRevision: 0,
			parkedRevision: undefined,
			inflightDigest: undefined,
		});

		context.log.append(address('mirrored'), encodeText('theirs'), 'accepted');
		expect(context.log.publication.status(address('mirrored'))).toBeUndefined();

		expect(context.log.publication.listDirty()).toEqual([address('authored')]);
		// The accepted bytes are still durably part of the chain.
		expect(decodeText(context.log.load(address('mirrored')))).toBe('theirs');
	} finally {
		context.sqlite.close();
	}
});

test('freeze captures complete state and a racing edit never mutates the image', () => {
	const context = setup();
	try {
		const target = address('frozen');
		context.log.append(target, encodeText('first'));
		const image = context.log.publication.freeze(target);
		expect(image).toBeDefined();
		expect(image!.revision).toBe(1);
		expect(image!.digest).toBe(sha256HexBytes(image!.update));
		expect(decodeText([image!.update])).toBe('first');

		// A racing local edit advances the durable revision but retries still
		// publish the exact frozen bytes.
		context.log.append(target, encodeText('racing'));
		const retried = context.log.publication.freeze(target);
		expect(retried!.revision).toBe(1);
		expect(retried!.digest).toBe(image!.digest);
		expect(retried!.update).toEqual(image!.update);
	} finally {
		context.sqlite.close();
	}
});

test('settle clears only a matching receipt and marks clean only at the captured revision', () => {
	const context = setup();
	try {
		const target = address('settled');
		context.log.append(target, encodeText('payload'));
		const image = context.log.publication.freeze(target)!;

		// A foreign or stale receipt changes nothing.
		context.log.publication.settle(target, { digest: 'not-the-digest' });
		expect(context.log.publication.status(target)!.inflightDigest).toBe(
			image.digest,
		);

		// A racing edit after the freeze keeps the address dirty past settlement.
		context.log.append(target, encodeText('after freeze'));
		context.log.publication.settle(target, { digest: image.digest });
		const status = context.log.publication.status(target)!;
		expect(status.acceptedRevision).toBe(1);
		expect(status.revision).toBe(2);
		expect(status.inflightDigest).toBeUndefined();
		expect(context.log.publication.listDirty()).toEqual([target]);

		// The newer revision freezes a new image and settles clean.
		const second = context.log.publication.freeze(target)!;
		expect(second.revision).toBe(2);
		expect(second.digest).not.toBe(image.digest);
		context.log.publication.settle(target, { digest: second.digest });
		expect(context.log.publication.listDirty()).toEqual([]);
	} finally {
		context.sqlite.close();
	}
});

test('an unsettled obligation and its frozen image survive reopen', () => {
	const context = setup();
	try {
		const target = address('restarted');
		context.log.append(target, encodeText('owed'));
		const image = context.log.publication.freeze(target)!;

		const reopened = createSqliteDocumentLog({
			database: context.database,
			isRowLive: () => true,
		});
		expect(reopened.publication.listDirty()).toEqual([target]);
		const resumed = reopened.publication.freeze(target)!;
		expect(resumed.digest).toBe(image.digest);
		expect(resumed.update).toEqual(image.update);
		reopened.publication.settle(target, { digest: resumed.digest });
		expect(reopened.publication.listDirty()).toEqual([]);
	} finally {
		context.sqlite.close();
	}
});

test('park removes an address from the drain until a later local edit advances it', () => {
	const context = setup();
	try {
		const target = address('parked');
		context.log.append(target, encodeText('too big'));
		context.log.publication.freeze(target);
		context.log.publication.park(target);
		expect(context.log.publication.listDirty()).toEqual([]);
		expect(context.log.publication.freeze(target)).toBeUndefined();
		// Parked is still durably owed, never silently cleared.
		expect(context.log.publication.status(target)).toEqual({
			revision: 1,
			acceptedRevision: 0,
			parkedRevision: 1,
			inflightDigest: undefined,
		});

		context.log.append(target, encodeText('shrunk'));
		expect(context.log.publication.listDirty()).toEqual([target]);
		expect(context.log.publication.freeze(target)!.revision).toBe(2);
	} finally {
		context.sqlite.close();
	}
});

test('clearInflight drops the retry image and keeps the address dirty', () => {
	const context = setup();
	try {
		const target = address('not-live-remotely');
		context.log.append(target, encodeText('owed'));
		const image = context.log.publication.freeze(target)!;
		context.log.publication.clearInflight(target);
		const status = context.log.publication.status(target)!;
		expect(status.inflightDigest).toBeUndefined();
		expect(context.log.publication.listDirty()).toEqual([target]);
		// A later settle against the dropped image is inert.
		context.log.publication.settle(target, { digest: image.digest });
		expect(context.log.publication.listDirty()).toEqual([target]);
	} finally {
		context.sqlite.close();
	}
});

test('row deletion removes the obligation in the same transaction as the chain', () => {
	const context = setup();
	try {
		context.log.append(address('doomed'), encodeText('owed'));
		context.log.append(address('kept'), encodeText('owed too'));
		context.database.transaction(() => {
			context.log.deleteRows([address('doomed')]);
		});
		expect(context.log.publication.status(address('doomed'))).toBeUndefined();
		expect(context.log.publication.listDirty()).toEqual([address('kept')]);

		context.database.transaction(() => {
			context.log.deleteAllRows();
		});
		expect(context.log.publication.listDirty()).toEqual([]);
	} finally {
		context.sqlite.close();
	}
});

test('compaction preserves the frozen retry image and the obligation watermarks', () => {
	const context = setup({ compactionThreshold: 3 });
	try {
		const target = address('compact-inflight');
		const shared = new Y.Doc();
		try {
			shared.get('editor').insert(0, 'a');
			context.log.append(
				target,
				new Uint8Array(Y.encodeStateAsUpdateV2(shared)),
			);
			const image = context.log.publication.freeze(target)!;
			for (const character of ['b', 'c']) {
				shared.get('editor').insert(shared.get('editor').length, character);
				context.log.append(
					target,
					new Uint8Array(Y.encodeStateAsUpdateV2(shared)),
				);
			}
			// The chain compacted to one row, yet the frozen bytes are unchanged.
			expect(countUpdates(context.database, target)).toBe(1);
			const retried = context.log.publication.freeze(target)!;
			expect(retried.digest).toBe(image.digest);
			expect(retried.revision).toBe(1);
			expect(context.log.publication.status(target)!.revision).toBe(3);
		} finally {
			shared.destroy();
		}
	} finally {
		context.sqlite.close();
	}
});

test('failed append transaction rolls back and poisons the log', () => {
	const sqlite = new Database(':memory:', { strict: true });
	const base = createBunSqliteAdapter(sqlite);
	let failNextTransaction = false;
	const database: SqliteDatabase = {
		run: base.run,
		all: base.all,
		transaction(run) {
			return base.transaction(() => {
				const result = run();
				if (failNextTransaction) {
					failNextTransaction = false;
					throw new Error('injected crash before commit');
				}
				return result;
			});
		},
	};
	try {
		const log = createSqliteDocumentLog({ database, isRowLive: () => true });
		log.append(address('crash-safe'), encodeText('a'));
		failNextTransaction = true;
		expect(() => log.append(address('crash-safe'), encodeText('b'))).toThrow(
			'injected crash before commit',
		);
		expect(() => log.load(address('crash-safe'))).toThrow(
			'injected crash before commit',
		);

		const reopened = createSqliteDocumentLog({
			database: base,
			isRowLive: () => true,
		});
		expect(decodeText(reopened.load(address('crash-safe')))).toBe('a');
	} finally {
		sqlite.close();
	}
});
