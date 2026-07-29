/**
 * The Direct Post rules from TikTok's content sharing guidelines, in one place.
 *
 * This module is the single owner of what a Direct Post is ALLOWED to be. The
 * server calls it before `video/init`, and the dashboard mirrors the same rules
 * so a creator sees why something is refused before submitting. The UI is a
 * convenience; this is the enforcement, because form fields are caller-supplied
 * and a replayed request can claim anything.
 *
 * It works in the CREATOR's vocabulary, not TikTok's wire vocabulary, and
 * translates at the boundary:
 *
 * - The creator opts IN to interactions ("Allow comments"), which is how the
 *   guidelines require the choice to be presented. TikTok's API takes the
 *   inverse (`disable_comment`), so the mapping happens here, once. Getting this
 *   backwards would silently publish with the opposite of what was agreed,
 *   which no type can catch.
 * - Commercial content is one disclosure toggle that then requires a kind, so
 *   "disclosed but unspecified" is unrepresentable rather than merely
 *   discouraged.
 */

import type {
	DirectPostInput,
	TikTokCreatorInfo,
	TikTokPrivacyLevel,
} from './api.js';
import { MAX_TITLE_LENGTH } from './api.js';

/**
 * What the creator opted IN to. All default to false: the guidelines require
 * every interaction control to start unchecked, so silence is never consent.
 */
export type InteractionChoices = {
	allowComment: boolean;
	allowDuet: boolean;
	allowStitch: boolean;
};

/**
 * The commercial content disclosure. `disclosed` is the single toggle that
 * starts OFF; the two kinds are only meaningful when it is on.
 */
export type CommercialDisclosure = {
	disclosed: boolean;
	/** "Promotional content": the post promotes the creator's own business. */
	yourBrand: boolean;
	/** "Paid partnership": the post promotes another brand for consideration. */
	brandedContent: boolean;
};

export type DirectPostChoices = {
	title: string;
	privacyLevel: TikTokPrivacyLevel;
	interactions: InteractionChoices;
	commercial: CommercialDisclosure;
	/**
	 * TikTok's permanent AI-generated label. Deliberately NOT part of the
	 * commercial disclosure: it is a separate claim about how the content was
	 * made, and a creator can need one without the other.
	 */
	aiGenerated: boolean;
	videoSize: number;
	/**
	 * Seconds, or `null` when the container could not be parsed server-side.
	 * For Direct Post `null` is a REFUSAL, not a pass: see the duration check in
	 * validateDirectPost.
	 */
	durationSec: number | null;
};

/** A refusal, phrased for the creator who has to act on it. */
export type DirectPostViolation = {
	/** Machine-readable so the UI can point at the right control. */
	field:
		| 'title'
		| 'privacyLevel'
		| 'interactions'
		| 'commercial'
		| 'duration'
		| 'video';
	message: string;
};

/**
 * The declaration a creator must agree to before publishing, which the
 * guidelines make conditional on the commercial disclosure.
 *
 * Branded content (alone or alongside Your Brand) pulls in the Branded Content
 * Policy; everything else needs only the Music Usage Confirmation.
 */
export type DeclarationKind = 'music' | 'branded-and-music';

export function declarationFor(
	commercial: CommercialDisclosure,
): DeclarationKind {
	return commercial.disclosed && commercial.brandedContent
		? 'branded-and-music'
		: 'music';
}

/**
 * The exact consent sentence for each declaration, so the server-side rules and
 * the dashboard cannot drift into describing different agreements.
 */
export const DECLARATION_TEXT: Record<DeclarationKind, string> = {
	music: 'By posting, you agree to TikTok’s Music Usage Confirmation.',
	'branded-and-music':
		'By posting, you agree to TikTok’s Branded Content Policy and Music Usage Confirmation.',
};

/** The label explanations the guidelines require beside each commercial kind. */
export const COMMERCIAL_LABELS = {
	yourBrand: {
		title: 'Your brand',
		/** TikTok shows this post as "Promotional content". */
		explanation:
			'You are promoting yourself or your own business. Your post will be labelled as Promotional content.',
	},
	brandedContent: {
		title: 'Branded content',
		/** TikTok shows this post as "Paid partnership". */
		explanation:
			'You are promoting another brand or a third party in exchange for something of value. Your post will be labelled as Paid partnership.',
	},
} as const;

/**
 * Validate the creator's choices against their CURRENT account options and turn
 * them into TikTok's wire shape.
 *
 * `creatorInfo` must come from a live `creator_info/query` for this
 * publish, never from a cached or client-supplied copy: the account's available
 * privacy levels and interaction ceilings can change between page load and
 * submit.
 */
export function validateDirectPost({
	choices,
	creatorInfo,
}: {
	choices: DirectPostChoices;
	creatorInfo: TikTokCreatorInfo;
}): { violation: DirectPostViolation } | { input: DirectPostInput } {
	const { title, privacyLevel, interactions, commercial } = choices;

	if (title.length === 0) {
		return {
			violation: { field: 'title', message: 'A caption is required.' },
		};
	}
	if (title.length > MAX_TITLE_LENGTH) {
		return {
			violation: {
				field: 'title',
				message: `A caption can be at most ${MAX_TITLE_LENGTH} characters.`,
			},
		};
	}

	// Privacy is never defaulted: the creator picks it, and the pick must be one
	// TikTok offers this account right now.
	if (!creatorInfo.privacyLevelOptions.includes(privacyLevel)) {
		return {
			violation: {
				field: 'privacyLevel',
				message: `TikTok does not currently offer "${privacyLevel}" for this account. Available: ${creatorInfo.privacyLevelOptions.join(', ')}.`,
			},
		};
	}

	// An account-wide "off" is a CEILING. One post cannot switch an interaction
	// back on, so opting in to a disabled interaction is refused rather than
	// quietly sent for TikTok to reinterpret.
	for (const [label, unavailable, optedIn] of [
		['comments', creatorInfo.commentDisabled, interactions.allowComment],
		['Duet', creatorInfo.duetDisabled, interactions.allowDuet],
		['Stitch', creatorInfo.stitchDisabled, interactions.allowStitch],
	] as const) {
		if (unavailable && optedIn) {
			return {
				violation: {
					field: 'interactions',
					message: `This TikTok account has ${label} switched off account-wide, so this post cannot enable it.`,
				},
			};
		}
	}

	if (commercial.disclosed) {
		// Disclosing commercial content without saying which kind is exactly the
		// state the guidelines forbid.
		if (!commercial.yourBrand && !commercial.brandedContent) {
			return {
				violation: {
					field: 'commercial',
					message:
						'You disclosed commercial content, so select at least one of Your brand or Branded content.',
				},
			};
		}
		// TikTok does not allow a paid partnership to be private: a Paid
		// partnership label on a post nobody can see cannot serve its purpose.
		if (commercial.brandedContent && privacyLevel === 'SELF_ONLY') {
			return {
				violation: {
					field: 'commercial',
					message:
						'Branded content cannot be private. Choose a non-private audience, or turn off Branded content.',
				},
			};
		}
	} else if (commercial.yourBrand || commercial.brandedContent) {
		// A kind selected while the disclosure is off would publish a commercial
		// label the creator never agreed to disclose.
		return {
			violation: {
				field: 'commercial',
				message:
					'Turn on the commercial content disclosure before choosing a content type.',
			},
		};
	}

	if (choices.videoSize <= 0) {
		return {
			violation: { field: 'video', message: 'A video file is required.' },
		};
	}

	// Duration FAILS CLOSED. TikTok's guidelines make checking the video length a
	// client responsibility, so an unknown length is a check this surface did not
	// perform, not a check TikTok will perform for us. This integration accepts
	// MP4 only, so unparseable means the file is not what this path supports and
	// must not reach the irreversible init.
	if (
		choices.durationSec === null ||
		!Number.isFinite(choices.durationSec) ||
		choices.durationSec <= 0
	) {
		return {
			violation: {
				field: 'duration',
				message:
					'Epicenter could not read this video’s length. Direct Post requires an MP4 whose duration can be verified before publishing.',
			},
		};
	}
	// A missing or zero account ceiling is equally unverifiable: without a live
	// maximum there is nothing to check the length against.
	if (creatorInfo.maxVideoDurationSec <= 0) {
		return {
			violation: {
				field: 'duration',
				message:
					'TikTok did not report a maximum video length for this account, so the length cannot be verified. Try again in a moment.',
			},
		};
	}
	if (choices.durationSec > creatorInfo.maxVideoDurationSec) {
		return {
			violation: {
				field: 'duration',
				message: `This video is ${Math.round(choices.durationSec)}s, but this TikTok account can post at most ${creatorInfo.maxVideoDurationSec}s.`,
			},
		};
	}

	return {
		input: {
			title,
			privacyLevel,
			// The one translation that matters: opt-in becomes TikTok's opt-out.
			disableComment: !interactions.allowComment,
			disableDuet: !interactions.allowDuet,
			disableStitch: !interactions.allowStitch,
			// Only a live disclosure sets a commercial toggle. With the disclosure
			// off, both are false regardless of any stale kind in the request.
			brandOrganic: commercial.disclosed && commercial.yourBrand,
			brandedContent: commercial.disclosed && commercial.brandedContent,
			// A separate, permanent claim the author owns, independent of the
			// commercial disclosure above.
			isAigc: choices.aiGenerated,
			videoSize: choices.videoSize,
		},
	};
}
