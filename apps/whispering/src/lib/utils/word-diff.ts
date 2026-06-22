/**
 * Word-level diff used to show a reshaped candidate against the original
 * selection.
 *
 * Delegates to jsdiff's `diffWords` (a Myers diff that matches on words and
 * ignores whitespace noise), then maps each change to a render-friendly segment
 * tagged unchanged, inserted (present only in the candidate), or deleted
 * (present only in the original).
 */

import { diffWords } from 'diff';

export type DiffSegment = {
	type: 'equal' | 'insert' | 'delete';
	text: string;
};

export function wordDiff(original: string, candidate: string): DiffSegment[] {
	return diffWords(original, candidate).map((change) => ({
		type: change.added ? 'insert' : change.removed ? 'delete' : 'equal',
		text: change.value,
	}));
}
