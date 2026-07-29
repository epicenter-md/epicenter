/**
 * The three safety predicates this subsystem expresses in SQL, verified as SQL.
 *
 * Both are enforced in the database WHERE rather than in a handler, so a caller
 * cannot reach past them, and both are compound `AND`/`OR` expressions where the
 * grouping IS the correctness. `a AND b OR c` and `a AND (b OR c)` differ by one
 * pair of parentheses and by whether a human can overwrite a live post.
 *
 * Rendering through `PgDialect` checks the real thing: the actual expression the
 * store hands Postgres, with its actual parenthesization. Asserting on a mirrored
 * copy of the expression would prove only that the copy matches itself.
 */

import { expect, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
	blocksNewPublishInSql,
	humanlyResolvableInSql,
	unsettledInSql,
} from './store.js';

const dialect = new PgDialect();

/**
 * The rendered predicate, with bind parameters substituted for readability.
 *
 * `and()`/`or()` are typed as possibly-undefined because they collapse when given
 * no operands. These builders always pass operands, so an undefined here would
 * mean a predicate had silently vanished, which is exactly the failure that would
 * make a WHERE match every row.
 */
function render(where: SQL | undefined): string {
	if (!where) throw new Error('predicate collapsed to undefined');
	const { sql, params } = dialect.sqlToQuery(where);
	return sql.replace(/\$(\d+)/g, (_match, index) =>
		JSON.stringify(params[Number(index) - 1]),
	);
}

// --- Which rows a human may adjudicate -----------------------------------

test('human resolution is an allowlist: no task named, and no answer yet', () => {
	const sql = render(humanlyResolvableInSql());

	// Both halves are required, and the status alternatives are GROUPED. Without
	// the parentheses, `publish_id is null and status is null or status = '...'`
	// parses as `(... and status is null) or status = 'INIT_AMBIGUOUS'`, which
	// would match an INIT_AMBIGUOUS row that already names a task.
	expect(sql).toBe(
		'("tiktok_publish_attempt"."publish_id" is null and ("tiktok_publish_attempt"."status" is null or "tiktok_publish_attempt"."status" = "INIT_AMBIGUOUS"))',
	);
});

test('human resolution names no status other than INIT_AMBIGUOUS', () => {
	// An allowlist, not a "not terminal" exclusion. The exclusion form admitted
	// PROCESSING_UPLOAD, UPLOAD_FAILED, and every status a future TikTok might
	// introduce, letting an assertion overwrite provider-observable state.
	const sql = render(humanlyResolvableInSql());

	expect(sql).not.toContain('not in');
	for (const provider of [
		'PROCESSING_UPLOAD',
		'PROCESSING_DOWNLOAD',
		'UPLOAD_FAILED',
		'PUBLISH_COMPLETE',
		'FAILED',
	]) {
		expect(sql).not.toContain(provider);
	}
});

// --- Which rows block a new publish --------------------------------------

test('the publish block is null-or-neither-terminal-nor-processing', () => {
	const sql = render(blocksNewPublishInSql());

	// `status IS NULL` OR (not settled AND not known-processing). The inner AND
	// must be grouped, or a null-status row would be the only thing that blocks.
	expect(sql).toBe(
		'("tiktok_publish_attempt"."status" is null or ("tiktok_publish_attempt"."status" not in ("PUBLISH_COMPLETE", "FAILED", "SEND_TO_USER_INBOX", "INIT_FAILED", "RESOLVED_POSTED", "RESOLVED_NOT_POSTED") and "tiktok_publish_attempt"."status" not in ("PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD")))',
	);
});

test('the publish block is stated as exclusions, so an unknown status blocks', () => {
	// FAILS CLOSED. Listing the blocking statuses instead would let a status this
	// build has never seen slip through as though it were finished, and the whole
	// point of the block is that "I do not know this word" stops publishing.
	const sql = render(blocksNewPublishInSql());

	expect(sql).toContain('not in');
	expect(sql).not.toContain('INIT_AMBIGUOUS');
	expect(sql).not.toContain('UPLOAD_FAILED');
});

test('every terminal status appears in the block exclusion', () => {
	// If a terminal status were missing here it would block publishing forever.
	const sql = render(blocksNewPublishInSql());

	for (const settled of [
		'PUBLISH_COMPLETE',
		'FAILED',
		'SEND_TO_USER_INBOX',
		'INIT_FAILED',
		'RESOLVED_POSTED',
		'RESOLVED_NOT_POSTED',
	]) {
		expect(sql).toContain(settled);
	}
});

// --- Which rows refuse a disconnect --------------------------------------

test('the disconnect refusal is broader than the publish block', () => {
	const disconnect = render(unsettledInSql());
	const publish = render(blocksNewPublishInSql());

	// A post TikTok is merely processing does not stop a NEW post, but it does stop
	// destroying the connection: revoking the token removes any way to ever ask
	// what became of it.
	expect(disconnect).not.toContain('PROCESSING_UPLOAD');
	expect(publish).toContain('PROCESSING_UPLOAD');
});

test('the disconnect refusal fails closed on an unknown status', () => {
	// An exclusion of settled statuses, so anything this build does not recognize
	// counts as unsettled and refuses.
	const sql = render(unsettledInSql());

	expect(sql).toBe(
		'("tiktok_publish_attempt"."status" is null or "tiktok_publish_attempt"."status" not in ("PUBLISH_COMPLETE", "FAILED", "SEND_TO_USER_INBOX", "INIT_FAILED", "RESOLVED_POSTED", "RESOLVED_NOT_POSTED"))',
	);
});
