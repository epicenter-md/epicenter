import { describe, expect, test } from 'bun:test';
import { bootFailure } from './boot-failure.js';

/**
 * The seam between what the store says and what a person reads.
 *
 * The point of these is not the wording, which will change. It is that a boot
 * failure never reaches a person as library vocabulary, and that a failure with
 * a specific repair offers that repair rather than the one button that fits
 * everything.
 */
describe('bootFailure', () => {
	test('a set of notes the account listed and then did not have retries', () => {
		// Nothing puts a generation in a URL any more (ADR-0339), so this is no
		// longer a hand-edited link: it is the account answering one way and then
		// another, which a reload re-asks. `Unaddressable` lost its arm with the
		// route, because its remaining producer is a signed-out account and the
		// wrapper answers that before anything opens.
		expect(bootFailure({ name: 'GenerationNotFound' }).repair).toBe('retry');
	});

	test('a copy belonging to another account offers the erase and nothing else', () => {
		// Nothing is deleted as a step in a protocol (ADR-0325, ADR-0281). The
		// screen is where a person is told they may, and the sentence says both
		// ways out.
		const failure = bootFailure({ name: 'BoundElsewhere' });
		expect(failure.repair).toBe('erase');
		expect(failure.message).toMatch(/different account/i);
		expect(failure.message).toMatch(/sign in as that account/i);
	});

	test('a second window says to close the other one', () => {
		expect(
			bootFailure({
				name: 'AlreadyOpen',
				message: 'This process already has epicenter/v4/x/y/1 open',
			}).message,
		).toMatch(/another honeycrisp window/i);
	});

	test('an unrecognized failure admits it rather than inventing a reason', () => {
		expect(
			bootFailure({
				name: 'UnknownFailure',
				message: 'The store could not be opened',
			}).message,
		).toMatch(/something went wrong/i);
	});

	test('no arm leaks store vocabulary to a person', () => {
		const machineWords =
			/replica|authority|database|document|log|head|dial|socket|struct|principal|projection|binding|generation/i;
		for (const error of [
			{ name: 'AlreadyOpen' },
			{ name: 'Unaddressable' },
			{ name: 'BoundElsewhere' },
			{ name: 'GenerationNotFound' },
			{ name: 'GenerationUnreachable' },
			{ name: 'UnknownFailure' },
			new Error('boom'),
			'not an object',
			null,
		]) {
			expect(bootFailure(error).message).not.toMatch(machineWords);
		}
	});
});
