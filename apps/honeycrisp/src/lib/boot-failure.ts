/**
 * What a person reads when Honeycrisp cannot open their notes.
 *
 * `@epicenter/data` states a failure for whoever is debugging one: an
 * unaddressable replica names the account it lacks. That sentence is correct
 * and it is not what someone who
 * opened a notes app should be handed. The library keeps its words; this picks
 * theirs.
 *
 * The boot gate renders both, this line and the library's underneath, so a
 * person is told what to do and a bug report still carries the real cause. That
 * also means a wrong guess here is visible rather than hidden, which is why the
 * fallback admits it does not know instead of inventing a reason.
 *
 * Only failures whose repair is specific enough to be worth naming get an arm.
 * A third arm earns itself when a third failure turns out to reach a person,
 * not before.
 */
export function bootFailureMessage(
	error: unknown,
	store: 'local' | 'account' = 'local',
): string {
	if (typeof error === 'object' && error !== null && 'name' in error) {
		switch (error.name) {
			case 'AlreadyOpen':
				return 'Another Honeycrisp window already has these notes open. Close it, then try again.';
			case 'Unaddressable':
				// The address could not be BUILT, and on both routes the usual
				// cause is the generation in the URL: a route hands over
				// `Number(params.generation)`, so a truncated paste or a
				// hand-edited link arrives as `NaN` and the store refuses it. It
				// used to share an arm with a refused credential and inherit
				// "restart", which is the one repair that cannot work: a restart
				// reopens the same URL.
				//
				// Its other cause, an account with no server or principal to
				// address, lands here too and is served by the same sentence,
				// because the route this points at re-resolves both from the
				// session.
				return store === 'account'
					? 'That link does not name notes in your account. Open Across your devices to see what is.'
					: 'That link does not name notes on this device. Open On this device to see what is.';
			case 'CredentialRefused':
				return store === 'account'
					? 'You are signed in, but Across your devices could not be opened. Sign in again.'
					: 'Your notes on this device could not be opened. Restarting Honeycrisp usually clears it.';
			case 'GenerationNotFound':
				// A link to a set of notes that is not here. Worth its own arm
				// because the repair is a person's, not a retry's: go back to the
				// notes that do exist.
				return store === 'account'
					? 'These notes are not in your account. Open Across your devices to see what is.'
					: 'These notes are not on this device. Open On this device to see what is.';
			case 'GenerationUnavailable':
				// Reachability, not absence, and the difference is the whole
				// reason it is a separate arm: this one a retry can fix.
				return 'Your notes could not be downloaded. Check your connection and try again.';
		}
	}
	return store === 'account'
		? 'Something went wrong opening Across your devices. Your notes on this device are still available.'
		: 'Something went wrong opening your notes on this device. Restarting Honeycrisp usually clears it.';
}
