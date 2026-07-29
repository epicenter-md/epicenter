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
 * EVERY published choice participates, with no exemptions. Direct Post sends all
 * of them in `post_info`, so each one changes what would appear on the profile,
 * and a field left out here would let an edited post silently reuse the previous
 * post's claim.
 */
export function fingerprintPublishIntent(intent: PublishIntent): string {
	const file = intent.file
		? `${intent.file.name}:${intent.file.size}:${intent.file.lastModified}`
		: 'no-file';
	const parts: string[] = [
		intent.connectionId,
		file,
		intent.title,
		intent.privacyLevel,
		String(intent.allowComment),
		String(intent.allowDuet),
		String(intent.allowStitch),
		String(intent.commercialContent),
		String(intent.yourBrand),
		String(intent.brandedContent),
		String(intent.aiGenerated),
	];
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

/**
 * One intent's claim, as persisted. Never contains a token or a credential.
 *
 * Keyed by CONNECTION, because a creator with several accounts has several
 * independent in-flight posts. Holding a single claim meant selecting a second
 * account overwrote the first account's record, which silently released a claim
 * that may already have created a post: the next submit on the first account
 * would mint a fresh key and originate a second one from a single consent.
 */
export type IntentClaim = {
	connectionId: string;
	fingerprint: string;
	key: string;
};

/**
 * How many unsettled claims are remembered at once.
 *
 * Bounded because this lives in `sessionStorage` and an unbounded map is its own
 * defect. Well above the number of accounts anyone posts to in one sitting, so
 * eviction is a backstop rather than part of normal operation. Claims are kept
 * most-recently-touched first and the tail is what falls off, so the claim most
 * likely to still matter is the last to go.
 */
export const MAX_TRACKED_INTENT_CLAIMS = 12;

/**
 * Where a keeper remembers its unsettled claims across page loads.
 *
 * A port rather than a direct `sessionStorage` call so the lifecycle is testable
 * without a DOM, and so a browser that refuses storage degrades to in-memory
 * instead of throwing. The whole list is read and written at once: it is a dozen
 * short records, and a single slot keeps the storage contract trivial.
 */
export type IntentClaimStore = {
	read(): IntentClaim[];
	write(claims: IntentClaim[]): void;
};

/** The default: remembers nothing beyond the current keeper instance. */
const inMemoryStore = (): IntentClaimStore => {
	let held: IntentClaim[] = [];
	return {
		read: () => held,
		write: (claims) => {
			held = claims;
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

/** Discard anything that is not a complete, contract-valid claim. */
function readClaims(raw: string | null): IntentClaim[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const claims: IntentClaim[] = [];
	for (const entry of parsed) {
		if (typeof entry !== 'object' || entry === null) continue;
		const { connectionId, fingerprint, key } = entry as Partial<IntentClaim>;
		// A partially written or hand-edited record is discarded rather than
		// trusted: a bad fingerprint would attach a key to the wrong post.
		if (
			typeof connectionId !== 'string' ||
			connectionId.length === 0 ||
			typeof fingerprint !== 'string' ||
			!isValidIdempotencyKey(key)
		) {
			continue;
		}
		claims.push({ connectionId, fingerprint, key });
	}
	return claims.slice(0, MAX_TRACKED_INTENT_CLAIMS);
}

/**
 * A `sessionStorage`-backed store, so a reload during a stalled publish recovers
 * the SAME key instead of minting a new intent.
 *
 * Session, never local: a claim is meaningful for as long as the tab is open and
 * must not outlive it. What is written is the connection id, the intent
 * fingerprint, and the generated key; no token, no credential, and nothing the
 * server would trust. Fingerprints are stored verbatim rather than hashed
 * because recovery depends on EXACT equality, and a hash collision would
 * silently reuse a key for a different post.
 *
 * Every access is guarded: a browser with storage disabled (Safari private mode,
 * a hardened profile) degrades to in-memory rather than breaking the publish
 * surface.
 */
export function createSessionIntentKeyStore(
	storage: StorageLike | null | undefined,
): IntentClaimStore {
	if (!storage) return inMemoryStore();
	// A memory mirror so a storage that reads back nothing still behaves
	// correctly within one page load.
	const fallback = inMemoryStore();
	return {
		read() {
			try {
				const claims = readClaims(storage.getItem(SESSION_STORAGE_KEY));
				return claims.length > 0 ? claims : fallback.read();
			} catch {
				return fallback.read();
			}
		},
		write(claims) {
			fallback.write(claims);
			try {
				if (claims.length === 0) storage.removeItem(SESSION_STORAGE_KEY);
				else storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(claims));
			} catch {
				// Quota or a disabled store: the in-memory mirror still holds the
				// claims for this page load, which is strictly better than failing the
				// post.
			}
		},
	};
}

/**
 * Holds the key for each connection's CURRENT intent and decides when a new one
 * is minted.
 *
 * Deliberately a tiny record-keeper rather than a hook or a store: the whole
 * behavior is "same intent keeps its key, per account", and that is easier to
 * test and to read as a plain object than as reactive plumbing. Keeping it here
 * rather than in the Svelte page also means the lifecycle is unit-tested beside
 * the contract the server validates, and the page stays thin.
 *
 * `newKey` is injected so tests can assert the lifecycle without depending on
 * randomness; production passes `crypto.randomUUID`. `store` is injected for the
 * same reason, and defaults to remembering nothing.
 */
export function createPublishIntentKeeper(
	newKey: () => string,
	store: IntentClaimStore = inMemoryStore(),
) {
	/** Move a connection's claim to the front, dropping any previous one. */
	function promote(claim: IntentClaim): void {
		const others = store
			.read()
			.filter((held) => held.connectionId !== claim.connectionId);
		store.write([claim, ...others].slice(0, MAX_TRACKED_INTENT_CLAIMS));
	}

	return {
		/**
		 * The key for this intent. Stable across repeated calls (a retry), stable
		 * across a reload, stable while other accounts are visited, and new only
		 * when THIS connection's intent materially changed.
		 *
		 * The store is consulted on every call rather than cached in a closure, so
		 * a keeper reconstructed after a reload recovers the claim on its first use
		 * with no separate hydration step to forget.
		 */
		keyFor(intent: PublishIntent): string {
			const fingerprint = fingerprintPublishIntent(intent);
			const held = store
				.read()
				.find((claim) => claim.connectionId === intent.connectionId);
			if (held?.fingerprint === fingerprint) {
				// Touching it keeps the active claim away from the eviction tail.
				promote(held);
				return held.key;
			}
			const claim = {
				connectionId: intent.connectionId,
				fingerprint,
				key: newKey(),
			};
			promote(claim);
			return claim.key;
		},

		/**
		 * Release ONE connection's key after a SETTLED outcome: the post reached a
		 * terminal status, or TikTok definitively refused it. The next intent on
		 * that account, even an identical one, gets a new key.
		 *
		 * Scoped to a connection precisely so settling one account cannot release
		 * another account's unsettled claim. Never call it for an ambiguous outcome,
		 * which includes a lost browser response and a same-key collision with an
		 * attempt that has not settled: the next submit must collide with the claim
		 * that may already have originated a post.
		 */
		settle(connectionId: string): void {
			store.write(
				store.read().filter((claim) => claim.connectionId !== connectionId),
			);
		},

		/** The key currently held for a connection, if any. For display and tests. */
		peek(connectionId: string): string | null {
			return (
				store.read().find((claim) => claim.connectionId === connectionId)
					?.key ?? null
			);
		},
	};
}

export type PublishIntentKeeper = ReturnType<typeof createPublishIntentKeeper>;
