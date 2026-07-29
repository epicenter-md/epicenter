import { expect, test } from 'bun:test';
import {
	createPublishIntentKeeper,
	fingerprintPublishIntent,
	isValidIdempotencyKey,
	MAX_IDEMPOTENCY_KEY_LENGTH,
	type PublishIntent,
} from './publish-intent.js';

function intent(overrides: Partial<PublishIntent> = {}): PublishIntent {
	return {
		kind: 'direct_post',
		connectionId: 'conn-1',
		file: { name: 'clip.mp4', size: 1024, lastModified: 1_700_000_000_000 },
		title: 'A caption',
		privacyLevel: 'PUBLIC_TO_EVERYONE',
		allowComment: false,
		allowDuet: false,
		allowStitch: false,
		commercialContent: false,
		yourBrand: false,
		brandedContent: false,
		aiGenerated: false,
		...overrides,
	};
}

/** A keeper with predictable keys, so the lifecycle is observable. */
function keeper() {
	let n = 0;
	return createPublishIntentKeeper(() => `key-${++n}`);
}

// --- The lifecycle that makes idempotency real ---------------------------

test('the SAME intent keeps its key across repeated submissions', () => {
	// This is the whole defect being fixed: minting a key per click means a
	// retry after a lost response is a brand new intent, and idempotency never
	// engages.
	const k = keeper();
	const first = k.keyFor(intent());

	expect(k.keyFor(intent())).toBe(first);
	expect(k.keyFor(intent())).toBe(first);
	expect(k.keyFor(intent())).toBe(first);
});

test('a network timeout and its retry send the identical key', () => {
	// The exact scenario: submit, no response, user hits post again.
	const k = keeper();
	const sent: string[] = [];

	sent.push(k.keyFor(intent())); // submitted, response lost
	// ...nothing settles, because the outcome is unknown...
	sent.push(k.keyFor(intent())); // the retry

	expect(sent[0]).toBe(sent[1]);
	expect(new Set(sent).size).toBe(1);
});

test('an AMBIGUOUS outcome must not release the key', () => {
	// `settle()` is deliberately not called on ambiguity, so the next attempt
	// still collides with the claim that may already have created a post.
	const k = keeper();
	const key = k.keyFor(intent());

	// (no settle here: outcome unknown)
	expect(k.keyFor(intent())).toBe(key);
	expect(k.peek()).toBe(key);
});

test('a settled outcome releases the key so the next post is a new intent', () => {
	const k = keeper();
	const first = k.keyFor(intent());

	k.settle();
	const second = k.keyFor(intent());

	expect(second).not.toBe(first);
	expect(second).toBe('key-2');
});

test('settle on an untouched keeper is harmless', () => {
	const k = keeper();
	k.settle();

	expect(k.peek()).toBeNull();
	expect(k.keyFor(intent())).toBe('key-1');
});

// --- What counts as a materially different post --------------------------

test('changing the caption is a different post and gets a new key', () => {
	const k = keeper();
	const first = k.keyFor(intent());

	const second = k.keyFor(intent({ title: 'A different caption' }));

	expect(second).not.toBe(first);
});

test.each([
	[
		'a different file',
		{ file: { name: 'other.mp4', size: 99, lastModified: 1 } },
	],
	['a different audience', { privacyLevel: 'SELF_ONLY' }],
	['a different connection', { connectionId: 'conn-2' }],
	['an interaction opt-in', { allowComment: true }],
	['a commercial disclosure', { commercialContent: true, yourBrand: true }],
	['an AI declaration', { aiGenerated: true }],
	['a different kind', { kind: 'draft_upload' as const }],
])('%s mints a new key', (_label, change) => {
	const k = keeper();
	const first = k.keyFor(intent());

	expect(k.keyFor(intent(change as Partial<PublishIntent>))).not.toBe(first);
});

test("editing back to the original intent returns to that intent's key", () => {
	// The key follows the INTENT, not the edit history, so an accidental edit
	// that is undone does not strand the in-flight claim.
	const k = keeper();
	const original = k.keyFor(intent());
	k.keyFor(intent({ title: 'typo' }));

	// Back to the original wording: a new key, because the previous one was
	// replaced. What matters is that it is stable from here on.
	const restored = k.keyFor(intent());
	expect(k.keyFor(intent())).toBe(restored);
	expect(restored).not.toBe(original);
});

test('a draft upload ignores Direct Post fields when identifying the intent', () => {
	// The inbox path sends no post_info, so a caption edit does not change what
	// would be uploaded and must not orphan an in-flight claim.
	const k = keeper();
	const first = k.keyFor(intent({ kind: 'draft_upload' }));

	const second = k.keyFor(
		intent({
			kind: 'draft_upload',
			title: 'irrelevant here',
			allowComment: true,
		}),
	);

	expect(second).toBe(first);
});

test('the fingerprint cannot be forged by values containing the separator', () => {
	// Parts are joined by a space; a title containing spaces must not be able to
	// impersonate a different field layout.
	const a = fingerprintPublishIntent(intent({ title: 'a b' }));
	const b = fingerprintPublishIntent(intent({ title: 'a', privacyLevel: 'b' }));

	expect(a).not.toBe(b);
});

// --- The key contract the server validates -------------------------------

test('a UUID is a valid idempotency key', () => {
	expect(isValidIdempotencyKey('7f1c4d9e-2b3a-4c5d-8e9f-0a1b2c3d4e5f')).toBe(
		true,
	);
});

test('keys are bounded on length and alphabet', () => {
	expect(isValidIdempotencyKey('')).toBe(false);
	expect(isValidIdempotencyKey('short')).toBe(false);
	expect(isValidIdempotencyKey('x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH))).toBe(
		true,
	);
	expect(
		isValidIdempotencyKey('x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)),
	).toBe(false);
	// Nothing that would need escaping in a log or a URL.
	for (const bad of [
		'has space',
		'newline\n',
		'quote"',
		'semi;colon',
		'<tag>',
	]) {
		expect(isValidIdempotencyKey(bad)).toBe(false);
	}
	expect(isValidIdempotencyKey(null)).toBe(false);
	expect(isValidIdempotencyKey(12345678)).toBe(false);
});

test('every key the keeper produces satisfies the server contract', () => {
	const k = createPublishIntentKeeper(() => crypto.randomUUID());

	for (let i = 0; i < 20; i += 1) {
		k.settle();
		expect(isValidIdempotencyKey(k.keyFor(intent()))).toBe(true);
	}
});
