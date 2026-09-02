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
	/** Go to the notes this account does have. The link named none. */
	| 'go-to-notes'
	/** Try again. Something outside this device has to change first. */
	| 'retry'
	/** Sign out, then in as the account this device's copy belongs to, or erase
	 * it (ADR-0325). Both are the person's, and neither happens by itself. */
	| 'erase';

export type BootFailure = {
	message: string;
	repair: BootRepair;
};

export function bootFailure(error: unknown): BootFailure {
	if (typeof error === 'object' && error !== null && 'name' in error) {
		switch (error.name) {
			case 'AlreadyOpen':
				return {
					message:
						'Another Honeycrisp window already has these notes open. Close it, then try again.',
					repair: 'retry',
				};
			case 'Unaddressable':
				// The store could not be NAMED, and the usual cause is the
				// generation in the URL: a route hands over
				// `Number(params.generation)`, so a truncated paste or a
				// hand-edited link arrives as `NaN` and the store refuses it.
				// Trying again reopens the same URL, which is the one repair that
				// cannot work, so the repair is to leave the URL.
				//
				// Its other cause, an account with no server or principal, lands
				// here too and is served by the same repair, because going to the
				// notes re-resolves both from the session.
				return {
					message: 'That link does not name any of your notes.',
					repair: 'go-to-notes',
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
				// A link to a set of notes that is not here. Worth its own arm
				// because the repair is a person's, not a retry's: go back to the
				// notes that do exist.
				return {
					message: 'These notes are not in your account.',
					repair: 'go-to-notes',
				};
			case 'GenerationUnavailable':
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
