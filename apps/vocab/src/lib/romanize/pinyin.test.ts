import { describe, expect, test } from 'bun:test';
import { pinyinRomanizer } from './pinyin.js';

describe('pinyinRomanizer', () => {
	test('segments cover the whole input in order, lossless', () => {
		const input = 'Hello 你好, world 世界!';
		const segments = pinyinRomanizer(input);
		expect(segments.map((s) => s.text).join('')).toBe(input);
	});

	test('Chinese characters get a reading; everything else does not', () => {
		const segments = pinyinRomanizer('你 a');
		const ni = segments.find((s) => s.text === '你');
		const latin = segments.find((s) => s.text.includes('a'));
		expect(ni?.reading).toBeTruthy();
		expect(latin?.reading).toBeUndefined();
	});

	test('one segment per Chinese character (per-character ruby)', () => {
		const chinese = pinyinRomanizer('你好').filter((s) => s.reading);
		expect(chinese.map((s) => s.text)).toEqual(['你', '好']);
	});

	test('each Chinese character is its own segment with its own reading', () => {
		const segments = pinyinRomanizer('我学习中文');
		const xue = segments.find((s) => s.text === '学');
		const xi = segments.find((s) => s.text === '习');

		expect(xue).toEqual({ text: '学', reading: xue?.reading });
		expect(xi).toEqual({ text: '习', reading: xi?.reading });
		expect(xue?.reading).toBeTruthy();
		expect(xi?.reading).toBeTruthy();
	});
});
