import { describe, expect, test } from 'bun:test';
import { bootFailureMessage } from './boot-failure.js';

/**
 * The seam between what the store says and what a person reads.
 *
 * The point of these is not the wording, which will change. It is that a boot
 * failure never reaches a person as library vocabulary, and that a failure with
 * a specific repair says the repair rather than "restart".
 */
describe('bootFailureMessage', () => {
	test('a refused credential says to sign in again, where signing in is the repair', () => {
		for (const name of ['Unaddressable', 'CredentialRefused']) {
			expect(
				bootFailureMessage({ name, message: 'internal' }, 'account'),
			).toMatch(/sign in again/i);
			// The same failure on the local store has no sign-in to offer, so it
			// names the repair that exists instead of one that does not.
			expect(
				bootFailureMessage({ name, message: 'internal' }, 'local'),
			).toMatch(/restarting honeycrisp/i);
		}
	});

	test('a second window says to close the other one', () => {
		expect(
			bootFailureMessage({
				name: 'AlreadyOpen',
				message: 'This process already has epicenter/x/local open',
			}),
		).toMatch(/another honeycrisp window/i);
	});

	test('an unrecognized failure admits it rather than inventing a reason', () => {
		const error = {
			name: 'UnknownFailure',
			message: 'The store could not be opened',
		};
		expect(bootFailureMessage(error, 'local')).toMatch(/something went wrong/i);
		expect(bootFailureMessage(error, 'account')).toMatch(
			/something went wrong/i,
		);
		// When the account copy is the one that failed, it still tells them their
		// notes are safe, which is the one thing somebody staring at a failed
		// boot actually wants to know. The local arm cannot say that, because the
		// copy on this device is the thing that would not open.
		expect(bootFailureMessage(error, 'account')).toMatch(
			/still available/i,
		);
		expect(bootFailureMessage(error, 'local')).toMatch(
			/restarting honeycrisp/i,
		);
	});

	test('no arm leaks store vocabulary to a person', () => {
		const machineWords =
			/replica|authority|database|document|log|head|dial|socket|struct|principal|projection/i;
		for (const error of [
			{ name: 'AlreadyOpen' },
			{ name: 'Unaddressable' },
			{ name: 'CredentialRefused' },
			{ name: 'UnknownFailure' },
			new Error('boom'),
			'not an object',
			null,
		]) {
			expect(bootFailureMessage(error)).not.toMatch(machineWords);
		}
	});
});
