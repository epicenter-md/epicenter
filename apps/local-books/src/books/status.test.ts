/**
 * `readBooksStatus` over the mirror site: what the orientation read reports
 * before anything is built, after a sync, and once a declaration edit has left a
 * predecessor on disk.
 *
 * The point of these three cases is that none of them is a fault. Under the old
 * hand-stamped scheme, "the file says v1 and the code says v2" was a mismatch the
 * opener repaired by dropping tables. There is no such state now: an artifact is
 * either the one this build names or it is a retained earlier shape nothing
 * reads (ADR-0194), and status reports which of those exist.
 */

import { describe, expect, test } from 'bun:test';
import {
	createMemoryTokenStore,
	makeConfig,
	tempDir,
} from '../../test/helpers.ts';
import { booksMirror, openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import { defineMirror, type MirrorSite } from '../mirror.ts';
import { companyDir } from '../paths.ts';
import { readBooksStatus } from './status.ts';

const REALM = 'r1';

/** Status for one temp data dir, optionally against a substitute mirror site. */
async function statusFor(dataDir: string, mirror?: MirrorSite) {
	return readBooksStatus({
		config: makeConfig({ dataDir, entities: ['Invoice'] }),
		realmId: REALM,
		mirror: mirror ?? booksMirror(dataDir, REALM),
		store: createMemoryTokenStore(),
	});
}

describe('readBooksStatus', () => {
	test('reports an unbuilt mirror without creating it', async () => {
		const tmp = tempDir();
		const site = booksMirror(tmp.dir, REALM);

		const status = await statusFor(tmp.dir);
		expect(status.mirrorBuilt).toBe(false);
		expect(status.mirrorPath).toBe(site.path);
		expect(status.predecessors).toEqual([]);
		expect(status.entities).toEqual([]);
		// A status read is not a build: the reader conjured nothing.
		expect(site.artifacts()).toEqual([]);
		tmp.cleanup();
	});

	test('reports the built mirror, its path, and its counts', async () => {
		const tmp = tempDir();
		const site = booksMirror(tmp.dir, REALM);
		const db = openBooksDb(site);
		db.ingest([{ def: entityDef('Invoice'), objects: [{ Id: 'i1' }] }], {
			syncedAt: '2026-01-01T00:00:00Z',
			realmState: {
				cdcCursor: 'c1',
				lastFullPullAt: 'c1',
				lastSyncedAt: 'c1',
			},
		});
		db.close();

		const status = await statusFor(tmp.dir);
		expect(status.mirrorBuilt).toBe(true);
		expect(status.mirrorPath).toBe(site.path);
		expect(status.predecessors).toEqual([]);
		expect(status.cdcCursor).toBe('c1');
		expect(status.entities).toEqual([
			{ entity: 'Invoice', rows: 1, deleted: 0, initialized: true },
		]);
		tmp.cleanup();
	});

	test('reports a retained predecessor as inventory, not as a mismatch', async () => {
		const tmp = tempDir();
		// Build under today's declaration, then read status as a build whose
		// declaration has since changed.
		const built = booksMirror(tmp.dir, REALM);
		openBooksDb(built).close();

		const nextShape = defineMirror({
			name: 'books',
			declaration: { tables: ['a different shape'] },
		}).at(companyDir(tmp.dir, REALM));

		const status = await statusFor(tmp.dir, nextShape);
		// The current shape has no materialization; the earlier one is listed but
		// never opened or consulted.
		expect(status.mirrorBuilt).toBe(false);
		expect(status.mirrorPath).toBe(nextShape.path);
		expect(status.predecessors).toEqual([built.fingerprint]);
		tmp.cleanup();
	});
});
