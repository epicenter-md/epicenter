import { expect, test } from 'bun:test';
import type { TikTokCreatorInfo } from './api.js';
import {
	DECLARATION_TEXT,
	type DirectPostChoices,
	declarationFor,
	validateDirectPost,
} from './direct-post-policy.js';

/** An account with everything available, so each test varies only what it studies. */
function creatorInfo(
	overrides: Partial<TikTokCreatorInfo> = {},
): TikTokCreatorInfo {
	return {
		username: 'braden',
		nickname: 'Braden',
		privacyLevelOptions: [
			'PUBLIC_TO_EVERYONE',
			'FOLLOWER_OF_CREATOR',
			'SELF_ONLY',
		],
		commentDisabled: false,
		duetDisabled: false,
		stitchDisabled: false,
		maxVideoDurationSec: 600,
		...overrides,
	};
}

/** Choices a compliant form produces: every toggle starts OFF. */
function choices(
	overrides: Partial<DirectPostChoices> = {},
): DirectPostChoices {
	return {
		title: 'A caption',
		privacyLevel: 'PUBLIC_TO_EVERYONE',
		interactions: { allowComment: false, allowDuet: false, allowStitch: false },
		commercial: { disclosed: false, yourBrand: false, brandedContent: false },
		aiGenerated: false,
		videoSize: 1024,
		durationSec: 30,
		...overrides,
	};
}

function expectInput(result: ReturnType<typeof validateDirectPost>) {
	if ('violation' in result) {
		throw new Error(
			`expected success, got violation: ${result.violation.message}`,
		);
	}
	return result.input;
}

function expectViolation(result: ReturnType<typeof validateDirectPost>) {
	if (!('violation' in result)) {
		throw new Error('expected a violation, got a valid input');
	}
	return result.violation;
}

// --- The opt-in to disable_* translation ---------------------------------

test('every interaction unchecked publishes with all of them DISABLED', () => {
	// The guidelines require the controls to start unchecked, so the default
	// request must disable all three rather than silently allowing them.
	const input = expectInput(
		validateDirectPost({ choices: choices(), creatorInfo: creatorInfo() }),
	);

	expect(input.disableComment).toBe(true);
	expect(input.disableDuet).toBe(true);
	expect(input.disableStitch).toBe(true);
});

test('each opt-in inverts to exactly its own disable_* flag', () => {
	// Getting this mapping backwards would publish the opposite of what the
	// creator agreed to, and no type could catch it.
	const input = expectInput(
		validateDirectPost({
			choices: choices({
				interactions: {
					allowComment: true,
					allowDuet: false,
					allowStitch: true,
				},
			}),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(input.disableComment).toBe(false);
	expect(input.disableDuet).toBe(true);
	expect(input.disableStitch).toBe(false);
});

test('opting in to an interaction the account disabled account-wide is refused', () => {
	const violation = expectViolation(
		validateDirectPost({
			choices: choices({
				interactions: {
					allowComment: true,
					allowDuet: false,
					allowStitch: false,
				},
			}),
			creatorInfo: creatorInfo({ commentDisabled: true }),
		}),
	);

	expect(violation.field).toBe('interactions');
	expect(violation.message).toContain('comments');
});

test('an account-wide disabled interaction still publishes when left unchecked', () => {
	const input = expectInput(
		validateDirectPost({
			choices: choices(),
			creatorInfo: creatorInfo({
				commentDisabled: true,
				duetDisabled: true,
				stitchDisabled: true,
			}),
		}),
	);

	expect(input.disableComment).toBe(true);
});

// --- Commercial content disclosure ---------------------------------------

test('the disclosure off publishes with both commercial toggles false', () => {
	const input = expectInput(
		validateDirectPost({ choices: choices(), creatorInfo: creatorInfo() }),
	);

	expect(input.brandOrganic).toBe(false);
	expect(input.brandedContent).toBe(false);
});

test('disclosing commercial content without a kind is refused', () => {
	const violation = expectViolation(
		validateDirectPost({
			choices: choices({
				commercial: {
					disclosed: true,
					yourBrand: false,
					brandedContent: false,
				},
			}),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(violation.field).toBe('commercial');
	expect(violation.message).toContain('at least one');
});

test('a kind selected while the disclosure is OFF is refused, not silently sent', () => {
	// Otherwise a stale form could publish a commercial label the creator never
	// agreed to disclose.
	const violation = expectViolation(
		validateDirectPost({
			choices: choices({
				commercial: {
					disclosed: false,
					yourBrand: true,
					brandedContent: false,
				},
			}),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(violation.field).toBe('commercial');
});

test('Your brand alone maps to brand_organic only', () => {
	const input = expectInput(
		validateDirectPost({
			choices: choices({
				commercial: { disclosed: true, yourBrand: true, brandedContent: false },
			}),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(input.brandOrganic).toBe(true);
	expect(input.brandedContent).toBe(false);
});

test('both kinds may be declared together', () => {
	const input = expectInput(
		validateDirectPost({
			choices: choices({
				commercial: { disclosed: true, yourBrand: true, brandedContent: true },
			}),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(input.brandOrganic).toBe(true);
	expect(input.brandedContent).toBe(true);
});

test('branded content with a PRIVATE audience is refused', () => {
	const violation = expectViolation(
		validateDirectPost({
			choices: choices({
				privacyLevel: 'SELF_ONLY',
				commercial: { disclosed: true, yourBrand: false, brandedContent: true },
			}),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(violation.field).toBe('commercial');
	expect(violation.message).toContain('cannot be private');
});

test('Your brand IS allowed with a private audience', () => {
	// Only the paid-partnership label is incompatible with private.
	const input = expectInput(
		validateDirectPost({
			choices: choices({
				privacyLevel: 'SELF_ONLY',
				commercial: { disclosed: true, yourBrand: true, brandedContent: false },
			}),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(input.privacyLevel).toBe('SELF_ONLY');
	expect(input.brandOrganic).toBe(true);
});

// --- Required declaration -------------------------------------------------

test('the declaration is Music Usage alone unless branded content is declared', () => {
	expect(
		declarationFor({
			disclosed: false,
			yourBrand: false,
			brandedContent: false,
		}),
	).toBe('music');
	expect(
		declarationFor({ disclosed: true, yourBrand: true, brandedContent: false }),
	).toBe('music');
});

test('branded content pulls in the Branded Content Policy, alone or with Your brand', () => {
	expect(
		declarationFor({ disclosed: true, yourBrand: false, brandedContent: true }),
	).toBe('branded-and-music');
	expect(
		declarationFor({ disclosed: true, yourBrand: true, brandedContent: true }),
	).toBe('branded-and-music');
});

test('the declaration sentences name the right agreements', () => {
	expect(DECLARATION_TEXT.music).toContain('Music Usage Confirmation');
	expect(DECLARATION_TEXT.music).not.toContain('Branded Content Policy');
	expect(DECLARATION_TEXT['branded-and-music']).toContain(
		'Branded Content Policy',
	);
	expect(DECLARATION_TEXT['branded-and-music']).toContain(
		'Music Usage Confirmation',
	);
});

// --- Privacy, caption, duration ------------------------------------------

test('a privacy level the account is not currently offered is refused', () => {
	const violation = expectViolation(
		validateDirectPost({
			choices: choices({ privacyLevel: 'PUBLIC_TO_EVERYONE' }),
			creatorInfo: creatorInfo({ privacyLevelOptions: ['SELF_ONLY'] }),
		}),
	);

	expect(violation.field).toBe('privacyLevel');
	expect(violation.message).toContain('SELF_ONLY');
});

test('an empty or over-long caption is refused', () => {
	expect(
		expectViolation(
			validateDirectPost({
				choices: choices({ title: '' }),
				creatorInfo: creatorInfo(),
			}),
		).field,
	).toBe('title');

	expect(
		expectViolation(
			validateDirectPost({
				choices: choices({ title: 'x'.repeat(2_201) }),
				creatorInfo: creatorInfo(),
			}),
		).field,
	).toBe('title');
});

test('a video longer than the account ceiling is refused with both numbers', () => {
	const violation = expectViolation(
		validateDirectPost({
			choices: choices({ durationSec: 700 }),
			creatorInfo: creatorInfo({ maxVideoDurationSec: 600 }),
		}),
	);

	expect(violation.field).toBe('duration');
	expect(violation.message).toContain('700');
	expect(violation.message).toContain('600');
});

test('a video exactly at the ceiling is allowed', () => {
	expect(
		expectInput(
			validateDirectPost({
				choices: choices({ durationSec: 600 }),
				creatorInfo: creatorInfo({ maxVideoDurationSec: 600 }),
			}),
		).title,
	).toBe('A caption');
});

test('an UNKNOWN duration FAILS CLOSED for Direct Post', () => {
	// TikTok makes checking the video length a client responsibility, so an
	// unreadable container means this surface did not perform a required check.
	// Passing it through would make TikTok the backstop for something the audit
	// path must verify itself.
	const violation = expectViolation(
		validateDirectPost({
			choices: choices({ durationSec: null }),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(violation.field).toBe('duration');
	expect(violation.message).toContain('could not read');
});

test.each([
	['zero', 0],
	['negative', -5],
	['not finite', Number.NaN],
	['infinite', Number.POSITIVE_INFINITY],
])('a %s duration is refused rather than treated as valid', (_label, value) => {
	expect(
		expectViolation(
			validateDirectPost({
				choices: choices({ durationSec: value }),
				creatorInfo: creatorInfo(),
			}),
		).field,
	).toBe('duration');
});

test('a missing account ceiling is refused: there is nothing to check against', () => {
	expect(
		expectViolation(
			validateDirectPost({
				choices: choices({ durationSec: 10 }),
				creatorInfo: creatorInfo({ maxVideoDurationSec: 0 }),
			}),
		).field,
	).toBe('duration');
});

test('a missing video is refused', () => {
	expect(
		expectViolation(
			validateDirectPost({
				choices: choices({ videoSize: 0 }),
				creatorInfo: creatorInfo(),
			}),
		).field,
	).toBe('video');
});

test('the AI-generated label is carried through independently of commerce', () => {
	const input = expectInput(
		validateDirectPost({
			choices: choices({ aiGenerated: true }),
			creatorInfo: creatorInfo(),
		}),
	);

	expect(input.isAigc).toBe(true);
	expect(input.brandOrganic).toBe(false);
	expect(input.brandedContent).toBe(false);
});
