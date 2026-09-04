/**
 * What a person reads when Honeycrisp cannot open their notes, and the one
 * thing they can do about it.
 *
 * `@epicenter/data` states a failure for whoever is debugging one: a store
 * bound elsewhere names the account it was created for. That sentence is
 * correct and it is not what someone who opened a notes app should be handed.
 * The library keeps its words; this picks theirs.
 *
 * The gate renders both, this line and the library's underneath, so a person is
 * told what to do and a bug report still carries the real cause. That also
 * means a wrong guess here is visible rather than hidden, which is why the
 * fallback admits it does not know instead of inventing a reason.
 *
 * **The repair is returned beside the sentence, because they were drifting
 * apart.** The gate used to render one Reconnect button under every message,
 * so a link that names no notes and a copy belonging to somebody else both
 * offered signing in again, which fixes neither. Naming the repair here is what
 * keeps the sentence and the button one decision.
 *
 * Three repairs, and the third is the honest absence of one. `'go-to-notes'`
 * sent a person to `/account`, and there is one URL now (ADR-0339); the
 * `Unaddressable` arm went with it, because its remaining producer is an
 * account naming no principal, which is a signed-out person, and the route
 * answers that before anything opens. `'none'` arrived with
 * `LocksUnsupported`: nothing a person does in the page changes whether their
 * browser ships the API, so the gate says what happened and offers nothing.
 *
 * There is one store, so there is one set of sentences. The second argument
 * this took, naming which of two notebooks failed, went with the device store:
 * an authority mints every generation (ADR-0336), so a person has one place
 * their notes are and every arm below points at it.
 *
 * Only failures whose repair is specific enough to be worth naming get an arm.
 * A new arm earns itself when a new failure turns out to reach a person, not
 * before. `CredentialRefused` had one and nothing in this repository throws it,
 * so the arm, its `'sign-in'` repair, and the test asserting the wording are
 * gone; give it a producer before giving it a sentence.
 */
export type BootRepair =
	/** Open again. Something outside this device has to change first. */
	| 'retry'
	/** Sign out, then in as the account this device's copy belongs to, or erase
	 * it (ADR-0325). Both are the person's, and neither happens by itself. */
	| 'erase'
	/** Nothing, and saying so is the point. A button that cannot help is worse
	 * than no button. */
	| 'none';

/**
 * Erase this device's copy, as the gate receives it.
 *
 * Declared here rather than imported from the handle, so a component takes the
 * verb it was handed and never the object that owns it.
 */
export type EraseReplica = () => Promise<{ error: unknown }>;

export type BootFailure = {
	message: string;
	repair: BootRepair;
};

export function bootFailure(error: unknown): BootFailure {
	if (typeof error === 'object' && error !== null && 'name' in error) {
		switch (error.name) {
			case 'AlreadyOpen':
				// A CONFIRMED ownership conflict and nothing else. The store used to
				// answer this name for a missing Web Locks API and a failed lock
				// request too, so this sentence told most of the people who reached
				// it to close a window they did not have open.
				return {
					message:
						'Another Honeycrisp window already has these notes open. Close it, then try again.',
					repair: 'retry',
				};
			case 'LocksUnsupported':
				// Not a conflict, and not a retry: this browser ships no Web Locks,
				// so nothing here can prove one window owns the notes, and opening
				// unguarded is the silent data loss the guard exists to prevent.
				return {
					message:
						'This browser is too old to open your notes safely. Update it, or use a different one.',
					repair: 'none',
				};
			case 'ClaimFailed':
				// The mechanism failed and said nothing about who holds it, so the
				// sentence does not guess either.
				return {
					message: 'Your notes could not be opened. Try again.',
					repair: 'retry',
				};
			case 'BoundElsewhere':
				// Somebody else signed into this device and their notes are still
				// here. Nothing was deleted to get to this screen and nothing will
				// be until the person below says so (ADR-0325, ADR-0281).
				return {
					message:
						'The notes on this device belong to a different account. Sign in as that account to open them, or erase this device’s copy and start fresh.',
					repair: 'erase',
				};
			case 'GenerationNotFound':
				// The account listed this set of notes and then did not have it,
				// which is a race rather than a link: nobody types the number any
				// more, because nothing puts one in a URL (ADR-0339). A reload asks
				// the account again and opens whatever it says now, so this retries
				// like a reachability failure and says so in the same words.
				return {
					message:
						'Your notes could not be opened. Check your connection and try again.',
					repair: 'retry',
				};
			case 'GenerationUnreachable':
				// Reachability, not absence, and the difference is the whole
				// reason it is a separate arm: this one a retry can fix.
				return {
					message:
						'Your notes could not be downloaded. Check your connection and try again.',
					repair: 'retry',
				};
		}
	}
	return {
		message: 'Something went wrong opening your notes.',
		repair: 'retry',
	};
}
