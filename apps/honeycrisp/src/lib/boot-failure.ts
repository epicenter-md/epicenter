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
export function bootFailureMessage(error: unknown): string {
	if (typeof error === 'object' && error !== null && 'name' in error) {
		switch (error.name) {
			case 'AlreadyOpen':
				return 'Another Honeycrisp window already has these notes open. Close it, then try again.';
			case 'Unaddressable':
			case 'CredentialRefused':
				return 'You are signed in, but this device could not load your account. Sign in again.';
		}
	}
	return 'Something went wrong opening your notes. They are still on this device; restarting Honeycrisp usually clears it.';
}
