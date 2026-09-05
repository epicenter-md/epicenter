import { describe, expect, test } from 'bun:test';
import { bootFailure } from './boot-failure';

/**
 * The seam between what the store says and what a person reads.
 *
 * The wording will change; what these pin is that library vocabulary never
 * reaches a person, and that a failure with a specific repair offers that
 * repair rather than the one button that fits everything.
 */
describe('bootFailure', () => {
	test('a copy belonging to another account offers the erase and nothing else', () => {
		const failure = bootFailure({ name: 'BoundElsewhere' });
		expect(failure.repair).toBe('erase');
		expect(failure.message).toMatch(/different account/i);
		expect(failure.message).toMatch(/sign in as that account/i);
	});

	test('a browser with no Web Locks is told the truth and offered nothing', () => {
		// There is no repair in the page: the API is missing, and opening
		// unguarded is the silent data loss the guard exists to prevent.
		const failure = bootFailure({ name: 'LocksUnsupported' });
		expect(failure.repair).toBe('none');
		expect(failure.message).toMatch(/browser/i);
	});

	test('only a confirmed conflict says to close a window', () => {
		expect(bootFailure({ name: 'AlreadyOpen' }).message).toMatch(
			/another whispering window/i,
		);
		for (const name of ['LocksUnsupported', 'ClaimFailed', 'BoundElsewhere']) {
			expect(bootFailure({ name }).message).not.toMatch(/window/i);
		}
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
			{ name: 'LocksUnsupported' },
			{ name: 'ClaimFailed' },
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
