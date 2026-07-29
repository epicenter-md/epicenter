import { expect, test } from 'bun:test';
import {
	blocksNewPublish,
	canReadRemoteStatus,
	describeAttemptStatus,
	isTerminalAttemptStatus,
	pickAttemptToFollow,
	requiresManualResolution,
} from './attempt-status.js';

// --- A claimed row with no answer is UNKNOWN, never "nothing happened" ----

test('a claimed attempt with no recorded status is UNKNOWN, not "not sent"', () => {
	// The row is inserted BEFORE `video/init`. A Worker that dies between the
	// init succeeding and the publish id being written leaves exactly this row,
	// so "nothing was published" is a claim the data does not support.
	const described = describeAttemptStatus(null);

	expect(described.tone).toBe('unknown');
	expect(described.detail).not.toContain('Nothing was published');
	// It must send the creator to TikTok, because nothing local can answer it.
	expect(described.detail).toContain('TikTok app');
});

test('a claimed attempt with no status blocks a new publish', () => {
	expect(blocksNewPublish(null)).toBe(true);
	expect(isTerminalAttemptStatus(null)).toBe(false);
});

// --- INIT_AMBIGUOUS cannot be polled, and must not pretend otherwise -----

test('INIT_AMBIGUOUS blocks publishing and needs a human, not a status read', () => {
	const attempt = { status: 'INIT_AMBIGUOUS', publishId: null };

	expect(blocksNewPublish(attempt.status)).toBe(true);
	// There is no publish id, so there is no task to ask TikTok about.
	expect(canReadRemoteStatus(attempt)).toBe(false);
	expect(requiresManualResolution(attempt)).toBe(true);
});

// --- Exactly which rows a human may adjudicate ---------------------------
//
// This is an ALLOWLIST, and the store's SQL mirrors it. A human recording an
// outcome must never be able to overwrite something the provider told us, or
// something the provider could still be asked about.

test.each([
	['a claimed row with no answer at all', null],
	['an init whose answer was lost', 'INIT_AMBIGUOUS'],
])('%s is humanly resolvable when no task was named', (_label, status) => {
	expect(requiresManualResolution({ status, publishId: null })).toBe(true);
});

test.each([
	// Provider-observable: TikTok can still be asked, so a human must not preempt it.
	['PROCESSING_UPLOAD', 'PROCESSING_UPLOAD'],
	['PROCESSING_DOWNLOAD', 'PROCESSING_DOWNLOAD'],
	['UPLOAD_FAILED', 'UPLOAD_FAILED'],
	// Already answered by TikTok, or already settled by a human.
	['PUBLISH_COMPLETE', 'PUBLISH_COMPLETE'],
	['FAILED', 'FAILED'],
	['INIT_FAILED', 'INIT_FAILED'],
	['RESOLVED_POSTED', 'RESOLVED_POSTED'],
	// A code this build has never seen. Fails closed: not resolvable by hand.
	['a future TikTok status', 'SOME_FUTURE_CODE'],
])('%s is NOT humanly resolvable', (_label, status) => {
	expect(requiresManualResolution({ status, publishId: null })).toBe(false);
});

test('a row that names a task is never humanly resolvable, whatever its status', () => {
	// A publish id means `status/fetch` can answer, so the honest remedy is to ask
	// TikTok rather than to let somebody assert a result.
	for (const status of [null, 'INIT_AMBIGUOUS', 'UPLOAD_FAILED']) {
		expect(requiresManualResolution({ status, publishId: 'pub-1' })).toBe(
			false,
		);
		expect(canReadRemoteStatus({ status, publishId: 'pub-1' })).toBe(true);
	}
});

test('the INIT_AMBIGUOUS description never promises that checking status resolves it', () => {
	const described = describeAttemptStatus('INIT_AMBIGUOUS');

	expect(described.tone).toBe('unknown');
	// The old copy said "Check status", which is impossible without a publish id.
	expect(described.detail.toLowerCase()).not.toContain('check status');
	expect(described.detail).toContain('TikTok app');
});

test('UPLOAD_FAILED blocks publishing but IS resolvable, because a task exists', () => {
	const attempt = { status: 'UPLOAD_FAILED', publishId: 'pub-1' };

	expect(blocksNewPublish(attempt.status)).toBe(true);
	expect(canReadRemoteStatus(attempt)).toBe(true);
	// Ask TikTok, never a human: the task is named and therefore observable.
	expect(requiresManualResolution(attempt)).toBe(false);
});

// --- What blocks what ----------------------------------------------------

test('a post TikTok is processing is known-committed: it blocks disconnect, not a new post', () => {
	for (const status of ['PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD']) {
		// We can state exactly what happened (TikTok accepted it), so a DIFFERENT
		// post from a new consent is not a duplicate risk.
		expect(blocksNewPublish(status)).toBe(false);
		// But it is not settled, so custody of the task must not be destroyed.
		expect(isTerminalAttemptStatus(status)).toBe(false);
	}
});

test('settled statuses block nothing', () => {
	for (const status of [
		'PUBLISH_COMPLETE',
		'FAILED',
		'SEND_TO_USER_INBOX',
		'INIT_FAILED',
		'RESOLVED_POSTED',
		'RESOLVED_NOT_POSTED',
	]) {
		expect(isTerminalAttemptStatus(status)).toBe(true);
		expect(blocksNewPublish(status)).toBe(false);
	}
});

test('an unrecognized status FAILS CLOSED and blocks everything', () => {
	// A status this build has never seen is not evidence of safety. Publishing is
	// irreversible, so the only safe reading of "I do not know this word" is to
	// stop.
	expect(isTerminalAttemptStatus('SOMETHING_NEW')).toBe(false);
	expect(blocksNewPublish('SOMETHING_NEW')).toBe(true);
	expect(describeAttemptStatus('SOMETHING_NEW').tone).toBe('unknown');
});

test('a human-recorded resolution says WHO decided it', () => {
	// These are not TikTok's words and must never read as though they were.
	expect(describeAttemptStatus('RESOLVED_POSTED').tone).toBe('posted');
	expect(describeAttemptStatus('RESOLVED_POSTED').label).toContain('you');
	expect(describeAttemptStatus('RESOLVED_NOT_POSTED').tone).toBe('failed');
	expect(describeAttemptStatus('RESOLVED_NOT_POSTED').label).toContain('you');
});

// --- Which attempt a surface resumes following ---------------------------

test('resuming picks the newest attempt that can actually be polled', () => {
	// Rows arrive newest first. The ambiguous one is newer but has no publish id,
	// so polling it is impossible; the surface must not silently skip the block it
	// represents, but it also cannot follow it.
	const attempts = [
		{ status: 'INIT_AMBIGUOUS', publishId: null },
		{ status: 'PROCESSING_UPLOAD', publishId: 'pub-live' },
		{ status: 'PUBLISH_COMPLETE', publishId: 'pub-old' },
	];

	expect(pickAttemptToFollow(attempts)?.publishId).toBe('pub-live');
});

test('nothing to resume when every attempt is settled or unpollable', () => {
	expect(
		pickAttemptToFollow([
			{ status: 'PUBLISH_COMPLETE', publishId: 'pub-1' },
			{ status: 'INIT_AMBIGUOUS', publishId: null },
			{ status: null, publishId: null },
		]),
	).toBeNull();
	expect(pickAttemptToFollow([])).toBeNull();
});
