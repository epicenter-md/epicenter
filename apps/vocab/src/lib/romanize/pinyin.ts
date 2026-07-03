import type { Romanizer, Segment } from '@epicenter/ui/markdown';
import { pinyin } from 'pinyin-pro';

/** CJK Unified Ideographs (simplified + traditional Chinese). */
const CJK_REGEX = /[一-鿿㐀-䶿豈-﫿]+/g;

/**
 * Per-character pinyin for Chinese runs; every other run (Latin, punctuation,
 * whitespace, HTML entities) passes through with no reading. The returned
 * segments cover the whole input in order, so concatenating their `text`
 * reproduces it exactly.
 */
export const pinyinRomanizer: Romanizer = (text) => {
	const segments: Segment[] = [];
	const regex = new RegExp(CJK_REGEX);
	let lastIndex = 0;
	let match: RegExpExecArray | null = regex.exec(text);
	while (match !== null) {
		if (match.index > lastIndex) {
			segments.push({ text: text.slice(lastIndex, match.index) });
		}
		const run = match[0];
		const readings = pinyin(run, { type: 'array' });
		let charIndex = 0;
		for (const char of run) {
			segments.push({
				text: char,
				reading: readings[charIndex] ?? '',
			});
			charIndex++;
		}
		lastIndex = match.index + run.length;
		match = regex.exec(text);
	}
	if (lastIndex < text.length) {
		segments.push({ text: text.slice(lastIndex) });
	}
	return segments;
};
