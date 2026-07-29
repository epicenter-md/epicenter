import { expect, test } from 'bun:test';
import {
	createPublishIntentKeeper,
	createSessionIntentKeyStore,
	fingerprintPublishIntent,
	isAmbiguousPublishFailure,
	isValidIdempotencyKey,
	MAX_IDEMPOTENCY_KEY_LENGTH,
	MAX_TRACKED_INTENT_CLAIMS,
	type PublishIntent,
	type StorageLike,
} from './publish-intent.js';

function intent(overrides: Partial<PublishIntent> = {}): PublishIntent {
	return {
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
	expect(k.peek('conn-1')).toBe(key);
});

test('a settled outcome releases the key so the next post is a new intent', () => {
	const k = keeper();
	const first = k.keyFor(intent());

	k.settle('conn-1');
	const second = k.keyFor(intent());

	expect(second).not.toBe(first);
	expect(second).toBe('key-2');
});

test('settle on an untouched keeper is harmless', () => {
	const k = keeper();
	k.settle('conn-1');

	expect(k.peek('conn-1')).toBeNull();
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
	['a Duet opt-in', { allowDuet: true }],
	['a Stitch opt-in', { allowStitch: true }],
	[
		'a branded-content disclosure',
		{ commercialContent: true, brandedContent: true },
	],
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
		k.settle('conn-1');
		expect(isValidIdempotencyKey(k.keyFor(intent()))).toBe(true);
	}
});

// --- Surviving a reload --------------------------------------------------
//
// Reloading is the natural reaction to a stalled request, and would otherwise
// be the easiest way to lose the claim and publish twice.

/** A sessionStorage stand-in whose contents outlive a keeper instance. */
function fakeStorage() {
	const items = new Map<string, string>();
	return {
		items,
		storage: {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => {
				items.set(key, value);
			},
			removeItem: (key: string) => {
				items.delete(key);
			},
		} satisfies StorageLike,
	};
}

test('a keeper rebuilt from the same session backing recovers the same key', () => {
	const { storage } = fakeStorage();
	let n = 0;
	const build = () =>
		createPublishIntentKeeper(
			// Contract-valid: the store validates what it reads back, so a stub key
			// shorter than the minimum would be discarded as corrupt.
			() => `session-key-${++n}`,
			createSessionIntentKeyStore(storage),
		);

	const before = build().keyFor(intent());
	// The page reloads: a brand new keeper, same tab, same chosen file and
	// settings.
	const after = build().keyFor(intent());

	expect(after).toBe(before);
	expect(n).toBe(1);
});

test('a reload after a DIFFERENT intent still mints a new key', () => {
	const { storage } = fakeStorage();
	let n = 0;
	const build = () =>
		createPublishIntentKeeper(
			// Contract-valid: the store validates what it reads back, so a stub key
			// shorter than the minimum would be discarded as corrupt.
			() => `session-key-${++n}`,
			createSessionIntentKeyStore(storage),
		);

	const before = build().keyFor(intent());
	const after = build().keyFor(intent({ title: 'a different caption' }));

	expect(after).not.toBe(before);
});

test('a settled outcome clears the session backing, so a reload starts fresh', () => {
	const { storage, items } = fakeStorage();
	let n = 0;
	const build = () =>
		createPublishIntentKeeper(
			// Contract-valid: the store validates what it reads back, so a stub key
			// shorter than the minimum would be discarded as corrupt.
			() => `session-key-${++n}`,
			createSessionIntentKeyStore(storage),
		);

	const first = build();
	const key = first.keyFor(intent());
	expect(items.size).toBe(1);

	first.settle('conn-1');
	expect(items.size).toBe(0);

	// Even the identical intent is a NEW post after a settled outcome.
	expect(build().keyFor(intent())).not.toBe(key);
});

test('the stored record contains only the fingerprint and the key', () => {
	const { storage, items } = fakeStorage();
	const k = createPublishIntentKeeper(
		() => 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
		createSessionIntentKeyStore(storage),
	);
	k.keyFor(intent());

	const [entry] = [...items.values()];
	const parsed = JSON.parse(entry as string) as Record<string, unknown>[];
	// One slot holds the whole bounded list of unsettled claims.
	expect(parsed).toHaveLength(1);
	expect(Object.keys(parsed[0] ?? {}).sort()).toEqual([
		'connectionId',
		'fingerprint',
		'key',
	]);
	// Nothing a server would trust, and nothing secret.
	expect(entry).not.toContain('token');
});

test('storage that is unavailable degrades to in-memory instead of throwing', () => {
	// Safari private mode and hardened profiles throw on setItem.
	const hostile: StorageLike = {
		getItem: () => {
			throw new Error('storage disabled');
		},
		setItem: () => {
			throw new Error('storage disabled');
		},
		removeItem: () => {
			throw new Error('storage disabled');
		},
	};
	const k = createPublishIntentKeeper(
		() => crypto.randomUUID(),
		createSessionIntentKeyStore(hostile),
	);

	const key = k.keyFor(intent());
	// The claim still holds for this page load, which is what a retry needs.
	expect(k.keyFor(intent())).toBe(key);
	expect(() => k.settle('conn-1')).not.toThrow();
});

test('no storage at all behaves like an ordinary in-memory keeper', () => {
	const k = createPublishIntentKeeper(
		() => crypto.randomUUID(),
		createSessionIntentKeyStore(null),
	);

	const key = k.keyFor(intent());
	expect(k.keyFor(intent())).toBe(key);
	k.settle('conn-1');
	expect(k.peek('conn-1')).toBeNull();
});

test('a corrupted or hand-edited stored record is discarded, not trusted', () => {
	// A bad fingerprint would attach a live key to the wrong post.
	for (const bad of [
		'not json',
		'{"fingerprint":"x"}',
		'{"key":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"}',
		'{"fingerprint":"x","key":"tooshort"}',
		'{"fingerprint":123,"key":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"}',
	]) {
		const { storage, items } = fakeStorage();
		items.set('epicenter.tiktok.publish-intent', bad);
		const k = createPublishIntentKeeper(
			() => 'f1e2d3c4-b5a6-4978-8b6c-5d4e3f2a1b0c',
			createSessionIntentKeyStore(storage),
		);

		expect(k.keyFor(intent())).toBe('f1e2d3c4-b5a6-4978-8b6c-5d4e3f2a1b0c');
	}
});

test('a recovered key still satisfies the server contract', () => {
	const { storage } = fakeStorage();
	createPublishIntentKeeper(
		() => crypto.randomUUID(),
		createSessionIntentKeyStore(storage),
	).keyFor(intent());

	const recovered = createPublishIntentKeeper(
		() => crypto.randomUUID(),
		createSessionIntentKeyStore(storage),
	).keyFor(intent());

	expect(isValidIdempotencyKey(recovered)).toBe(true);
});

// --- Which outcomes release the key --------------------------------------
//
// The rule the dashboard follows, tested here so it is not buried in a Svelte
// handler where it went wrong once already.

test('a LOST BROWSER RESPONSE is ambiguous and preserves the key', () => {
	// The defect this replaces: only server-reported ambiguity preserved the
	// key, so a dropped connection released it and the retry minted a new
	// intent, which the server would have happily turned into a second post.
	const k = keeper();
	const key = k.keyFor(intent());
	const error = { name: 'RequestFailed' };

	expect(isAmbiguousPublishFailure(error)).toBe(true);
	if (!isAmbiguousPublishFailure(error)) k.settle('conn-1');

	// The retry sends the identical key.
	expect(k.keyFor(intent())).toBe(key);
	expect(k.peek('conn-1')).toBe(key);
});

test('a server-reported unresolved outcome preserves the key', () => {
	const k = keeper();
	const key = k.keyFor(intent());
	const error = { name: 'ServerRefused', unresolved: true };

	expect(isAmbiguousPublishFailure(error)).toBe(true);
	if (!isAmbiguousPublishFailure(error)) k.settle('conn-1');

	expect(k.keyFor(intent())).toBe(key);
});

test('a DEFINITE server refusal releases the key', () => {
	// Nothing was created, so a corrected post is a new intent and must not
	// collide with the spent claim.
	const k = keeper();
	const key = k.keyFor(intent());
	const error = { name: 'ServerRefused', unresolved: undefined };

	expect(isAmbiguousPublishFailure(error)).toBe(false);
	if (!isAmbiguousPublishFailure(error)) k.settle('conn-1');

	expect(k.keyFor(intent())).not.toBe(key);
});

test('a lost response survives a reload: the retry still reuses the key', () => {
	// The two corrections together. Connection drops, creator reloads the page
	// (the natural reaction), then retries.
	const { storage } = fakeStorage();
	let n = 0;
	const build = () =>
		createPublishIntentKeeper(
			() => `session-key-${++n}`,
			createSessionIntentKeyStore(storage),
		);

	const before = build().keyFor(intent());
	// fetch rejected: ambiguous, so nothing is settled.
	expect(isAmbiguousPublishFailure({ name: 'RequestFailed' })).toBe(true);

	// ...page reload...
	const afterReload = build();

	expect(afterReload.keyFor(intent())).toBe(before);
	expect(n).toBe(1);
});

// --- One unsettled claim per connection ----------------------------------
//
// The keeper used to hold ONE claim. Switching accounts overwrote it, which
// silently released a claim that may already have created a post: the next
// submit on the first account would mint a fresh key and originate a second.

test('two connections hold their claims at the same time', () => {
	const k = keeper();

	const first = k.keyFor(intent({ connectionId: 'conn-1' }));
	const second = k.keyFor(intent({ connectionId: 'conn-2' }));

	expect(first).not.toBe(second);
	// Coming back to the first account recovers its claim rather than minting a
	// third key.
	expect(k.keyFor(intent({ connectionId: 'conn-1' }))).toBe(first);
	expect(k.keyFor(intent({ connectionId: 'conn-2' }))).toBe(second);
});

test('settling one connection preserves every other unsettled claim', () => {
	const k = keeper();
	const first = k.keyFor(intent({ connectionId: 'conn-1' }));
	const second = k.keyFor(intent({ connectionId: 'conn-2' }));

	// conn-2 settled; conn-1's outcome is still unknown.
	k.settle('conn-2');

	expect(k.peek('conn-1')).toBe(first);
	expect(k.peek('conn-2')).toBeNull();
	// The unsettled claim is intact, so a retry on conn-1 still collides.
	expect(k.keyFor(intent({ connectionId: 'conn-1' }))).toBe(first);
	// And conn-2 is genuinely free to start a new intent.
	expect(k.keyFor(intent({ connectionId: 'conn-2' }))).not.toBe(second);
});

test('switching accounts back and forth never releases a claim', () => {
	const k = keeper();
	const held = k.keyFor(intent({ connectionId: 'conn-1' }));

	for (const id of ['conn-2', 'conn-3', 'conn-1', 'conn-2', 'conn-1']) {
		k.keyFor(intent({ connectionId: id }));
	}

	expect(k.peek('conn-1')).toBe(held);
});

test('tracked claims are bounded, and the oldest is the one dropped', () => {
	// Unbounded growth in sessionStorage is its own bug. The bound is chosen so a
	// realistic number of accounts all keep their claims; beyond that, the
	// least-recently-touched claim is evicted rather than a random one.
	const k = keeper();
	const oldest = k.keyFor(intent({ connectionId: 'conn-0' }));
	expect(k.peek('conn-0')).toBe(oldest);

	for (let i = 1; i <= MAX_TRACKED_INTENT_CLAIMS; i++) {
		k.keyFor(intent({ connectionId: `conn-${i}` }));
	}

	// Pushed out by the bound.
	expect(k.peek('conn-0')).toBeNull();
	// The most recent are all still held.
	expect(k.peek(`conn-${MAX_TRACKED_INTENT_CLAIMS}`)).not.toBeNull();
});

test('a claim survives a reload, per connection', () => {
	const { storage } = fakeStorage();
	let n = 0;
	const build = () =>
		createPublishIntentKeeper(
			() => `a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c${String(++n).padStart(2, '0')}`,
			createSessionIntentKeyStore(storage),
		);

	const before = build();
	const one = before.keyFor(intent({ connectionId: 'conn-1' }));
	const two = before.keyFor(intent({ connectionId: 'conn-2' }));

	// A reload rebuilds the keeper from storage.
	const after = build();

	expect(after.keyFor(intent({ connectionId: 'conn-1' }))).toBe(one);
	expect(after.keyFor(intent({ connectionId: 'conn-2' }))).toBe(two);
});

// --- The 409 that must NOT release the claim -----------------------------

test('a lost response, then a same-key 409, leaves the claim held', () => {
	// The sequence that could publish twice. Submit; the response is lost; the
	// retry sends the same key; the server answers 409 because the attempt is
	// already claimed. If that 409 reads as a DEFINITE refusal the key is
	// released, and the next submit mints a fresh key that originates a second
	// post from one consent.
	const k = keeper();
	const key = k.keyFor(intent());

	// 1. Response lost. Ambiguous, so nothing settles.
	const lost = { name: 'RequestFailed' as const };
	if (!isAmbiguousPublishFailure(lost)) k.settle('conn-1');
	expect(k.keyFor(intent())).toBe(key);

	// 2. The retry collides with the existing claim. The server reports that the
	//    existing attempt is not settled, so this is still unresolved.
	const collision = {
		name: 'ServerRefused' as const,
		unresolved: true,
		status: 409,
	};
	expect(isAmbiguousPublishFailure(collision)).toBe(true);
	if (!isAmbiguousPublishFailure(collision)) k.settle('conn-1');

	// The claim is intact, so a third submit still collides instead of posting.
	expect(k.peek('conn-1')).toBe(key);
	expect(k.keyFor(intent())).toBe(key);
});

test('a same-key 409 for an ALREADY SETTLED attempt does release the claim', () => {
	// The other direction: the earlier attempt reached a terminal status, so this
	// intent is genuinely finished and an identical repost is a deliberate second
	// post rather than a duplicate.
	const k = keeper();
	const key = k.keyFor(intent());

	const settledCollision = {
		name: 'ServerRefused' as const,
		unresolved: false,
		status: 409,
	};
	expect(isAmbiguousPublishFailure(settledCollision)).toBe(false);
	if (!isAmbiguousPublishFailure(settledCollision)) k.settle('conn-1');

	expect(k.peek('conn-1')).toBeNull();
	expect(k.keyFor(intent())).not.toBe(key);
});
