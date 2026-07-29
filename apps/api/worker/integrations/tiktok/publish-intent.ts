/**
 * What an idempotency key IS, owned in one place for both sides of the wire.
 *
 * The server validates keys against this contract; the dashboard generates keys
 * that conform to it and, crucially, decides WHEN a new one is minted. Both
 * halves live here because a key the client rotates too eagerly is not
 * idempotency at all, and that failure is invisible from either side alone.
 *
 * The rule that makes this work: one INTENDED POST owns one key, for as long as
 * that intent is unchanged and unsettled.
 *
 * - A retry after a lost response must send the SAME key, so the server
 *   recognizes the attempt it already claimed and refuses to originate a second
 *   post. Minting a key per click (`crypto.randomUUID()` in the submit handler)
 *   looks like idempotency but provides none: every retry is a new intent.
 * - Editing the caption, swapping the video, or changing the audience is a
 *   DIFFERENT post, so it must get a new key or the server would refuse it as a
 *   duplicate of something the creator no longer wants to publish.
 * - A settled outcome (published, or definitively rejected) releases the key, so
 *   the next post starts fresh.
 * - An AMBIGUOUS outcome does NOT release it. That is the whole point: the next
 *   attempt has to collide with the existing claim. A LOST BROWSER RESPONSE is
 *   ambiguous too: the request may have reached the Worker, which may have
 *   reached TikTok, so a failed `fetch` is not evidence that nothing happened.
 * - The key survives a page RELOAD, because reloading is the natural reaction
 *   to a stalled request and would otherwise be the easiest way to lose the
 *   claim and publish twice. See {@link createSessionIntentKeyStore}.
 */

/**
 * Keys travel in a multipart field and land in a Postgres unique index, so they
 * are bounded on both length and alphabet. A UUID is 36 characters; the ceiling
 * leaves room for a caller-supplied scheme without admitting unbounded input.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
/** Printable, URL-safe, and free of anything that would need escaping in a log. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Whether a caller-supplied key is acceptable. Rejecting out of contract is
 * cheap; admitting an unbounded string into a unique index is not.
 */
export function isValidIdempotencyKey(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= MIN_IDEMPOTENCY_KEY_LENGTH &&
		value.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
		IDEMPOTENCY_KEY_PATTERN.test(value)
	);
}

/**
 * Everything that makes one intended post DIFFERENT from another.
 *
 * Deliberately the full set of published choices, not just the file: publishing
 * the same video with a different caption or a different audience is a
 * different post, and reusing a key across that change would have the server
 * refuse the creator's actual intent as a duplicate.
 */
export type PublishIntent = {
	kind: 'direct_post' | 'draft_upload';
	connectionId: string;
	/** Identifies the chosen file without reading it: name, size, mtime. */
	file: { name: string; size: number; lastModified: number } | null;
	title: string;
	privacyLevel: string;
	allowComment: boolean;
	allowDuet: boolean;
	allowStitch: boolean;
	commercialContent: boolean;
	yourBrand: boolean;
	brandedContent: boolean;
	aiGenerated: boolean;
};

/**
 * A stable string for one intent. Two intents that would publish the same post
 * produce the same fingerprint; any material difference produces a different
 * one.
 *
 * A draft upload deliberately ignores the Direct Post fields: the inbox path
 * sends no `post_info`, so a caption edit does not change what would be
 * uploaded and must not orphan an in-flight claim.
 */
export function fingerprintPublishIntent(intent: PublishIntent): string {
	const file = intent.file
		? `${intent.file.name}:${intent.file.size}:${intent.file.lastModified}`
		: 'no-file';
	const parts: string[] = [intent.kind, intent.connectionId, file];
	if (intent.kind === 'direct_post') {
		parts.push(
			intent.title,
			intent.privacyLevel,
			String(intent.allowComment),
			String(intent.allowDuet),
			String(intent.allowStitch),
			String(intent.commercialContent),
			String(intent.yourBrand),
			String(intent.brandedContent),
			String(intent.aiGenerated),
		);
	}
	// Each part is length-prefixed, so the joined string parses back to exactly
	// one tuple no matter what characters a caption contains. A plain separator
	// would let a crafted title impersonate a different field layout.
	return parts.map((part) => `${part.length}:${part}`).join('|');
}

/**
 * Whether a failed publish leaves the outcome UNKNOWN, and therefore whether
 * the intent key must be PRESERVED rather than released.
 *
 * The client half of the same judgement `isAmbiguousFailure` makes on the
 * server, and it exists as a function so the rule is testable instead of
 * living inline in a Svelte handler.
 *
 * Two distinct ambiguities, both fatal to get wrong:
 *
 * - `RequestFailed`: the browser never saw an answer. The request may have
 *   reached the Worker, which may have reached TikTok. A dropped connection is
 *   NOT evidence that nothing happened, so releasing the key here would let the
 *   retry mint a new intent and originate a second post.
 * - `ServerRefused` carrying `unresolved`: the Worker saw the call and could
 *   not determine its outcome.
 *
 * Everything else is a definite refusal that created nothing, so the key is
 * released and a corrected post starts a fresh intent.
 */
export function isAmbiguousPublishFailure(error: {
	name: string;
	unresolved?: boolean;
}): boolean {
	if (error.name === 'RequestFailed') return true;
	return error.name === 'ServerRefused' && error.unresolved === true;
}

/** One intent's claim, as persisted. Never contains a token or a credential. */
export type IntentKeyRecord = { fingerprint: string; key: string };

/**
 * Where a keeper remembers its current claim across page loads.
 *
 * A port rather than a direct `sessionStorage` call so the lifecycle is
 * testable without a DOM, and so a browser that refuses storage degrades to
 * in-memory instead of throwing.
 */
export type IntentKeyStore = {
	read(): IntentKeyRecord | null;
	write(record: IntentKeyRecord): void;
	clear(): void;
};

/** The default: remembers nothing beyond the current keeper instance. */
const inMemoryStore = (): IntentKeyStore => {
	let held: IntentKeyRecord | null = null;
	return {
		read: () => held,
		write: (record) => {
			held = record;
		},
		clear: () => {
			held = null;
		},
	};
};

/** The minimum of the Web Storage API this needs. */
export type StorageLike = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

/**
 * The single storage slot this integration uses. Narrow on purpose: one key,
 * one namespace, nothing else touched.
 */
const SESSION_STORAGE_KEY = 'epicenter.tiktok.publish-intent';

/**
 * A `sessionStorage`-backed store, so a reload during a stalled publish
 * recovers the SAME key instead of minting a new intent.
 *
 * Session, never local: the claim is meaningful for as long as the tab is open
 * and must not outlive it. What is written is the intent fingerprint and the
 * generated key; no token, no credential, and nothing the server would trust.
 * The fingerprint is stored verbatim rather than hashed because recovery
 * depends on EXACT equality, and a hash collision would silently reuse a key
 * for a different post.
 *
 * Every access is guarded: a browser with storage disabled (Safari private
 * mode, a hardened profile) degrades to in-memory rather than breaking the
 * publish surface.
 */
export function createSessionIntentKeyStore(
	storage: StorageLike | null | undefined,
): IntentKeyStore {
	if (!storage) return inMemoryStore();
	// A memory mirror so a storage that reads back nothing still behaves
	// correctly within one page load.
	const fallback = inMemoryStore();
	return {
		read() {
			try {
				const raw = storage.getItem(SESSION_STORAGE_KEY);
				if (!raw) return fallback.read();
				const parsed = JSON.parse(raw) as Partial<IntentKeyRecord>;
				// A partially written or hand-edited record is discarded rather than
				// trusted: a bad fingerprint would attach this key to the wrong post.
				if (
					typeof parsed?.fingerprint !== 'string' ||
					!isValidIdempotencyKey(parsed?.key)
				) {
					return null;
				}
				return { fingerprint: parsed.fingerprint, key: parsed.key };
			} catch {
				return fallback.read();
			}
		},
		write(record) {
			fallback.write(record);
			try {
				storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(record));
			} catch {
				// Quota or a disabled store: the in-memory mirror still holds the key
				// for this page load, which is strictly better than failing the post.
			}
		},
		clear() {
			fallback.clear();
			try {
				storage.removeItem(SESSION_STORAGE_KEY);
			} catch {
				// Nothing to do: the mirror is already cleared.
			}
		},
	};
}

/**
 * Holds the key for the CURRENT intent and decides when a new one is minted.
 *
 * Deliberately a tiny state machine rather than a hook or a store: the whole
 * behavior is "same intent keeps its key", and that is easier to test and to
 * read as a plain object than as reactive plumbing. Keeping it here rather than
 * in the Svelte page also means the lifecycle is unit-tested beside the
 * contract the server validates, and the page stays thin.
 *
 * `newKey` is injected so tests can assert the lifecycle without depending on
 * randomness; production passes `crypto.randomUUID`. `store` is injected for
 * the same reason, and defaults to remembering nothing.
 */
export function createPublishIntentKeeper(
	newKey: () => string,
	store: IntentKeyStore = inMemoryStore(),
) {
	return {
		/**
		 * The key for this intent. Stable across repeated calls (a retry), stable
		 * across a reload, new whenever the intent materially changed.
		 *
		 * The store is consulted on every call rather than cached in a closure, so
		 * a keeper reconstructed after a reload recovers the claim on its first
		 * use with no separate hydration step to forget.
		 */
		keyFor(intent: PublishIntent): string {
			const fingerprint = fingerprintPublishIntent(intent);
			const held = store.read();
			if (held?.fingerprint === fingerprint) return held.key;
			const record = { fingerprint, key: newKey() };
			store.write(record);
			return record.key;
		},

		/**
		 * Release the key after a SETTLED outcome: the post was accepted, or
		 * TikTok definitively refused it. The next intent, even an identical one,
		 * gets a new key.
		 *
		 * Never call this for an ambiguous outcome, which includes a lost browser
		 * response. The next attempt must collide with the claim that may already
		 * have originated a post.
		 */
		settle(): void {
			store.clear();
		},

		/** The key currently held, if any. Exposed for display and for tests. */
		peek(): string | null {
			return store.read()?.key ?? null;
		},
	};
}

export type PublishIntentKeeper = ReturnType<typeof createPublishIntentKeeper>;
