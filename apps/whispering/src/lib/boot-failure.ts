/**
 * What a person reads when Whispering cannot open their recordings, and the one
 * thing they can do about it.
 *
 * `@epicenter/data` states a failure precisely for whoever is debugging one;
 * this picks the sentence someone who opened a dictation app should be handed,
 * and the repair that fits it. The gate renders both, so a bug report still
 * carries the library's wording underneath. Vocabulary split: ADR-0244.
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
				// A confirmed ownership conflict and nothing else. Every other way
				// a claim can fail has its own name below, so this sentence only
				// reaches someone who really does have a second window.
				return {
					message:
						'Another Whispering window already has your recordings open. Close it, then try again.',
					repair: 'retry',
				};
			case 'LocksUnsupported':
				// Not a conflict, and not a retry: this browser ships no Web Locks,
				// so nothing here can prove one window owns the recordings, and
				// opening unguarded is the silent data loss the guard prevents.
				return {
					message:
						'This browser is too old to open your recordings safely. Update it, or use a different one.',
					repair: 'none',
				};
			case 'ClaimFailed':
				// The mechanism failed and said nothing about who holds it, so the
				// sentence does not guess either.
				return {
					message: 'Your recordings could not be opened. Try again.',
					repair: 'retry',
				};
			case 'BoundElsewhere':
				// Somebody else signed into this device and their recordings are
				// still here. Nothing was deleted to get to this screen and nothing
				// will be until the person below says so (ADR-0325, ADR-0281).
				return {
					message:
						'The recordings on this device belong to a different account. Sign in as that account to open them, or erase this device’s copy and start fresh.',
					repair: 'erase',
				};
			case 'GenerationNotFound':
				// The account listed this set of recordings and then did not have
				// it, which is a race rather than a bad link: nothing puts the
				// number in a URL. Trying again asks the account and opens whatever
				// it says now.
				return {
					message:
						'Your recordings could not be opened. Check your connection and try again.',
					repair: 'retry',
				};
			case 'GenerationUnreachable':
				// Reachability, not absence, and the difference is the whole reason
				// it is a separate arm: this one a retry can fix.
				return {
					message:
						'Your recordings could not be downloaded. Check your connection and try again.',
					repair: 'retry',
				};
		}
	}
	return {
		message: 'Something went wrong opening your recordings.',
		repair: 'retry',
	};
}
