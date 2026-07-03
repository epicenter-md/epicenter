/**
 * The HTTP read surface's projections (db.ts's `listMessages`,
 * `getMessageDetail`, `listLabels`). These are the read models `local-mail up`
 * serves to the triage SPA; the point of the tests is that they project Gmail's
 * own mirrored bytes (label ids, epoch dates, headers, extracted body) without
 * inventing state: label filtering is a `json_each` over the stored `labelIds`,
 * search is a plain `LIKE`, and the detail pulls `To`/`Date` from the raw blob.
 */

import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MailDb, openMailDb } from './db.ts';
import type { GmailLabel, GmailMessage } from './schema.ts';

function openTmp(): { db: MailDb; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-read-'));
	const db = openMailDb({ dataDir: dir, accountEmail: 'you@example.com' });
	return {
		db,
		cleanup: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function message(over: Partial<GmailMessage> & { id: string }): GmailMessage {
	return {
		threadId: `thread-${over.id}`,
		labelIds: ['INBOX', 'UNREAD'],
		snippet: 'a snippet',
		internalDate: '1700000000000',
		payload: {
			headers: [
				{ name: 'Subject', value: 'Default subject' },
				{ name: 'From', value: 'Sender <sender@example.com>' },
				{ name: 'To', value: 'you@example.com' },
				{ name: 'Date', value: 'Mon, 2 Jul 2026 19:19:00 -0700' },
			],
			parts: [{ mimeType: 'text/plain', body: { data: b64url('Hello body') } }],
		},
		...over,
	};
}

function label(id: string, name: string, type: string): GmailLabel {
	return { id, name, type };
}

function seed(db: MailDb) {
	db.ingestFullPullPage(
		[
			message({
				id: 'newest',
				internalDate: '3000',
				labelIds: ['INBOX', 'UNREAD', 'Label_7'],
				payload: {
					headers: [
						{ name: 'Subject', value: 'Invoice for June' },
						{ name: 'From', value: 'Billing <billing@acme.com>' },
						{ name: 'To', value: 'you@example.com' },
						{ name: 'Date', value: 'Tue, 1 Jul 2026 08:00:00 -0700' },
					],
					parts: [
						{
							mimeType: 'text/plain',
							body: { data: b64url('Please pay the invoice.') },
						},
					],
				},
			}),
			message({
				id: 'middle',
				internalDate: '2000',
				labelIds: ['CATEGORY_PROMOTIONS'],
			}),
			message({ id: 'oldest', internalDate: '1000', labelIds: ['INBOX'] }),
		],
		new Date().toISOString(),
	);
	db.ingestLabels(
		[
			label('INBOX', 'INBOX', 'system'),
			label('Label_7', 'Altered Trajectories', 'user'),
			label('CATEGORY_PROMOTIONS', 'CATEGORY_PROMOTIONS', 'system'),
		],
		new Date().toISOString(),
	);
}

describe('listMessages', () => {
	test('returns rows newest first with parsed labelIds', () => {
		const { db, cleanup } = openTmp();
		try {
			seed(db);
			const rows = db.listMessages({ limit: 100, offset: 0 });
			expect(rows.map((r) => r.id)).toEqual(['newest', 'middle', 'oldest']);
			expect(rows[0]?.labelIds).toEqual(['INBOX', 'UNREAD', 'Label_7']);
		} finally {
			cleanup();
		}
	});

	test('label filter matches only messages carrying that label', () => {
		const { db, cleanup } = openTmp();
		try {
			seed(db);
			const inbox = db.listMessages({
				labelId: 'INBOX',
				limit: 100,
				offset: 0,
			});
			expect(inbox.map((r) => r.id)).toEqual(['newest', 'oldest']);
			const promos = db.listMessages({
				labelId: 'CATEGORY_PROMOTIONS',
				limit: 100,
				offset: 0,
			});
			expect(promos.map((r) => r.id)).toEqual(['middle']);
		} finally {
			cleanup();
		}
	});

	test('search matches subject, sender, or body', () => {
		const { db, cleanup } = openTmp();
		try {
			seed(db);
			expect(
				db
					.listMessages({ search: 'invoice', limit: 100, offset: 0 })
					.map((r) => r.id),
			).toEqual(['newest']);
			expect(
				db
					.listMessages({ search: 'billing@acme', limit: 100, offset: 0 })
					.map((r) => r.id),
			).toEqual(['newest']);
			expect(
				db.listMessages({ search: 'nomatchxyz', limit: 100, offset: 0 }),
			).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('limit and offset paginate', () => {
		const { db, cleanup } = openTmp();
		try {
			seed(db);
			expect(db.listMessages({ limit: 1, offset: 0 }).map((r) => r.id)).toEqual(
				['newest'],
			);
			expect(db.listMessages({ limit: 1, offset: 1 }).map((r) => r.id)).toEqual(
				['middle'],
			);
		} finally {
			cleanup();
		}
	});
});

describe('getMessageDetail', () => {
	test('projects To/Date headers and the extracted body', () => {
		const { db, cleanup } = openTmp();
		try {
			seed(db);
			const detail = db.getMessageDetail('newest');
			expect(detail?.subject).toBe('Invoice for June');
			expect(detail?.to).toBe('you@example.com');
			expect(detail?.date).toBe('Tue, 1 Jul 2026 08:00:00 -0700');
			expect(detail?.bodyText).toBe('Please pay the invoice.');
			expect(detail?.labelIds).toEqual(['INBOX', 'UNREAD', 'Label_7']);
		} finally {
			cleanup();
		}
	});

	test('returns null for an unmirrored id', () => {
		const { db, cleanup } = openTmp();
		try {
			seed(db);
			expect(db.getMessageDetail('ghost')).toBeNull();
		} finally {
			cleanup();
		}
	});
});

describe('listLabels', () => {
	test('returns every mirrored label with id, name, and type', () => {
		const { db, cleanup } = openTmp();
		try {
			seed(db);
			const labels = db.listLabels();
			expect(labels).toHaveLength(3);
			expect(labels.find((l) => l.id === 'Label_7')).toEqual({
				id: 'Label_7',
				name: 'Altered Trajectories',
				type: 'user',
			});
		} finally {
			cleanup();
		}
	});
});
