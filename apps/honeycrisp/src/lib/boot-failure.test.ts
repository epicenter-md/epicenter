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
	test('a link that names nothing sends them to the notes that exist', () => {
		// A route hands the store `Number(params.generation)`, so a hand-edited
		// or truncated link arrives as NaN. Trying again reopens the same URL, so
		// offering a retry is the one answer that cannot work.
		for (const name of ['Unaddressable', 'GenerationNotFound']) {
			expect(bootFailure({ name }).repair).toBe('go-to-notes');
		}
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
			{ name: 'GenerationUnavailable' },
			{ name: 'UnknownFailure' },
			new Error('boom'),
			'not an object',
			null,
		]) {
			expect(bootFailure(error).message).not.toMatch(machineWords);
		}
	});
});
