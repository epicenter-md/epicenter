import { describe, expect, test } from 'bun:test';
import { type BootVocabulary, bootFailure } from './boot-failure.js';

/**
 * The seam between what the store says and what a person reads.
 *
 * The point of these is not the wording, which will change. It is that a boot
 * failure never reaches a person as library vocabulary, and that a failure with
 * a specific repair offers that repair rather than the one button that fits
 * everything.
 *
 * Merged from `apps/honeycrisp/src/lib/boot-failure.test.ts` and
 * `apps/whispering/src/lib/boot-failure.test.ts`, which asserted the same seven
 * facts about two copies of one switch. Every wording assertion runs once per
 * application, so both apps' sentences stay pinned and Vocab's arrive pinned:
 * it had no gate at all, so a copy belonging to another account was a dead end
 * there, with the erase that repairs it never offered.
 *
 * Key behaviors:
 * - Each repair is chosen by the failure, not by one button that fits all
 * - Only a CONFIRMED ownership conflict tells a person to close a window
 * - No arm leaks store vocabulary to a person
 */

const vocabularies: BootVocabulary[] = [
	{
		appName: 'Honeycrisp',
		subject: 'notes',
		eraseDescription: 'Every note on this device will be deleted.',
	},
	{
		appName: 'Whispering',
		subject: 'recordings',
		eraseDescription:
			'Every recording on this device will be deleted, along with its audio.',
	},
	{
		appName: 'Vocab',
		subject: 'conversations',
		eraseDescription: 'Every conversation on this device will be deleted.',
	},
];

describe.each(vocabularies)('bootFailure for $appName', (vocabulary) => {
	const { appName, subject } = vocabulary;

	test('a set the account listed and then did not have retries', () => {
		// Nothing puts a generation in a URL any more (ADR-0339), so this is no
		// longer a hand-edited link: it is the account answering one way and then
		// another, which opening again re-asks. `Unaddressable` lost its arm with
		// the route, because its remaining producer is a signed-out account and
		// the boot node answers that before anything opens.
		expect(bootFailure({ name: 'GenerationNotFound' }, vocabulary).repair).toBe(
			'retry',
		);
	});

	test('a copy belonging to another account offers the erase and nothing else', () => {
		// Nothing is deleted as a step in a protocol (ADR-0325, ADR-0281). The
		// screen is where a person is told they may, and the sentence says both
		// ways out.
		const failure = bootFailure({ name: 'BoundElsewhere' }, vocabulary);
		expect(failure.repair).toBe('erase');
		expect(failure.message).toMatch(/different account/i);
		expect(failure.message).toMatch(/sign in as that account/i);
		expect(failure.message).toContain(subject);
	});

	test('a second window says to close the other one, by name', () => {
		expect(
			bootFailure(
				{
					name: 'AlreadyOpen',
					message: 'Another context already has epicenter/v4/x/y/1 open',
				},
				vocabulary,
			).message,
		).toMatch(new RegExp(`another ${appName} window`, 'i'));
	});

	test('only a confirmed conflict says to close a window', () => {
		// The store used to answer `AlreadyOpen` for a missing Web Locks API, a
		// lock request that threw, and an address that already held a copy. Three
		// quarters of the people who read that sentence were being told to close a
		// window they did not have open (ADR-0344).
		for (const name of [
			'LocksUnsupported',
			'ClaimFailed',
			'GenerationExists',
			'BoundElsewhere',
		]) {
			expect(bootFailure({ name }, vocabulary).message).not.toMatch(/window/i);
		}
	});

	test('a browser with no Web Locks is told the truth and offered nothing', () => {
		// There is no repair in the page: the API is missing, and opening
		// unguarded is the silent data loss the guard exists to prevent. A button
		// that cannot help is worse than no button.
		const failure = bootFailure({ name: 'LocksUnsupported' }, vocabulary);
		expect(failure.repair).toBe('none');
		expect(failure.message).toMatch(/browser/i);
	});

	test('a lock request that threw retries without naming a cause', () => {
		// It says nothing about who holds it, because nothing knows.
		const failure = bootFailure({ name: 'ClaimFailed' }, vocabulary);
		expect(failure.repair).toBe('retry');
		expect(failure.message).toContain(subject);
	});

	test('an unrecognized failure admits it rather than inventing a reason', () => {
		expect(
			bootFailure(
				{ name: 'UnknownFailure', message: 'The store could not be opened' },
				vocabulary,
			).message,
		).toMatch(/something went wrong/i);
	});

	test('no arm leaks store vocabulary to a person', () => {
		const machineWords =
			/replica|authority|database|document|log|head|dial|socket|struct|principal|projection|binding|generation/i;
		for (const error of [
			{ name: 'AlreadyOpen' },
			{ name: 'LocksUnsupported' },
			{ name: 'ClaimFailed' },
			{ name: 'GenerationExists' },
			{ name: 'Unaddressable' },
			{ name: 'BoundElsewhere' },
			{ name: 'GenerationNotFound' },
			{ name: 'GenerationUnreachable' },
			{ name: 'UnknownFailure' },
			new Error('boom'),
			'not an object',
			null,
		]) {
			expect(bootFailure(error, vocabulary).message).not.toMatch(machineWords);
		}
	});
});
