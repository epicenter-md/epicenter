/**
 * What a person reads when an application cannot open their data, and the one
 * thing they can do about it.
 *
 * `@epicenter/data` states a failure for whoever is debugging one: a store
 * bound elsewhere names the account it was created for. That sentence is
 * correct and it is not what someone who opened a notes app should be handed.
 * The library keeps its words; this picks theirs (ADR-0244).
 *
 * The gate renders both, this line and the library's underneath, so a person is
 * told what to do and a bug report still carries the real cause. That also
 * means a wrong guess here is visible rather than hidden, which is why the
 * fallback admits it does not know instead of inventing a reason.
 *
 * **The repair is returned beside the sentence, because they were drifting
 * apart.** The gate used to render one Reconnect button under every message, so
 * a link that names no notes and a copy belonging to somebody else both offered
 * signing in again, which fixes neither. Naming the repair here is what keeps
 * the sentence and the button one decision.
 *
 * **One copy of this, taking the application's nouns.** It was two files, in
 * Honeycrisp and in Whispering, with the same six arms and the same three
 * repairs, differing only in the word for a person's stuff. Vocab had neither,
 * so it rendered `extractErrorMessage` and one Try again: a copy belonging to
 * another account was a dead end there, because the erase that repairs it was
 * never offered.
 *
 * Only failures whose repair is specific enough to be worth naming get an arm.
 * A new arm earns itself when a new failure turns out to reach a person, not
 * before. `CredentialRefused` had one and nothing in this repository throws it,
 * so the arm and its `'sign-in'` repair are gone; give it a producer before
 * giving it a sentence.
 */

/**
 * The nouns an application lends this file, because they are the application's.
 *
 * A library states a failure precisely and an application decides what a person
 * is told about it (ADR-0244). These three are that decision, and they are
 * declared at the boot node that renders the gate rather than in a package that
 * has never met the person reading them.
 */
export type BootVocabulary = {
	/** The window a person is told to close, e.g. `'Honeycrisp'`. */
	appName: string;
	/**
	 * What this application calls a person's stuff, plural, e.g. `'notes'`.
	 *
	 * It is the same word the account popover syncs, so the gate passes it
	 * straight through as `syncNoun` rather than asking for it twice.
	 */
	subject: string;
	/**
	 * The whole of what the erase dialog says, stated rather than templated.
	 *
	 * **Not built from `subject`, deliberately.** This is the copy in front of an
	 * irreversible deletion, and the applications do not agree on what it has to
	 * say: Whispering's recordings carry audio blobs, so its sentence names them
	 * and Honeycrisp's must not. A template with a hole for a noun cannot express
	 * that difference, and the version that could would be a template with a hole
	 * for a clause, which is this field with extra steps.
	 */
	eraseDescription: string;
};

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
 * verb it was handed and never the object that owns it. It rides on the
 * `failed` variant of a data session, which is the one state it can succeed in:
 * erasing takes the same claim an open takes, and a failed open released its
 * claim before it returned (ADR-0340).
 */
export type EraseReplica = () => Promise<{ error: unknown }>;

export type BootFailure = {
	message: string;
	repair: BootRepair;
};

export function bootFailure(
	error: unknown,
	{ appName, subject }: BootVocabulary,
): BootFailure {
	if (typeof error === 'object' && error !== null && 'name' in error) {
		switch (error.name) {
			case 'AlreadyOpen':
				// A CONFIRMED ownership conflict and nothing else. The store used to
				// answer this name for a missing Web Locks API, a lock request that
				// threw, and an address that already held a copy, so this sentence
				// told most of the people who reached it to close a window they did
				// not have open (ADR-0344).
				return {
					message: `Another ${appName} window already has your ${subject} open. Close it, then try again.`,
					repair: 'retry',
				};
			case 'LocksUnsupported':
				// Not a conflict, and not a retry: this browser ships no Web Locks, so
				// nothing here can prove one window owns the data, and opening
				// unguarded is the silent data loss the guard exists to prevent.
				return {
					message: `This browser is too old to open your ${subject} safely. Update it, or use a different one.`,
					repair: 'none',
				};
			case 'ClaimFailed':
				// The mechanism failed and said nothing about who holds it, so the
				// sentence does not guess either.
				return {
					message: `Your ${subject} could not be opened. Try again.`,
					repair: 'retry',
				};
			case 'BoundElsewhere':
				// Somebody else signed into this device and their copy is still here.
				// Nothing was deleted to get to this screen and nothing will be until
				// the person below says so (ADR-0325, ADR-0281).
				return {
					message: `The ${subject} on this device belong to a different account. Sign in as that account to open them, or erase this device’s copy and start fresh.`,
					repair: 'erase',
				};
			case 'GenerationNotFound':
				// The account listed this set and then did not have it, which is a
				// race rather than a bad link: nobody types the number and nothing
				// puts one in a URL (ADR-0339). Trying again asks the account and
				// opens whatever it says now, so this retries like a reachability
				// failure and says so in the same words.
				return {
					message: `Your ${subject} could not be opened. Check your connection and try again.`,
					repair: 'retry',
				};
			case 'GenerationUnreachable':
				// Reachability, not absence, and the difference is the whole reason it
				// is a separate arm: this one a retry can fix.
				return {
					message: `Your ${subject} could not be downloaded. Check your connection and try again.`,
					repair: 'retry',
				};
		}
	}
	return {
		message: `Something went wrong opening your ${subject}.`,
		repair: 'retry',
	};
}
