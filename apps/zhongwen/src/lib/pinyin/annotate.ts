import { pinyin } from 'pinyin-pro';

/** Regex matching CJK Unified Ideographs (simplified + traditional Chinese). */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;

/**
 * Annotate CJK characters in an HTML string with ruby pinyin tags.
 *
 * Splits HTML by tags so only text nodes are processed—tag names
 * and attributes are left untouched.
 */
export function annotateHtml(html: string): string {
	// Split into HTML tags and text nodes. Odd indices are tags, even are text.
	const parts = html.split(/(<[^>]*>)/);

	for (let i = 0; i < parts.length; i += 2) {
		const text = parts[i];
		if (!text) continue;
		parts[i] = text.replace(CJK_REGEX, (match) => {
			const chars = [...match];
			const pinyinArray = pinyin(match, { type: 'array' });
			return chars
				.map(
					(char, j) =>
						`<ruby>${char}<rp>(</rp><rt>${pinyinArray[j] ?? ''}</rt><rp>)</rp></ruby>`,
				)
				.join('');
		});
	}

	return parts.join('');
}
