/**
 * Tests for icon and KV normalization functions.
 *
 * Note: Table normalization is now handled by the `table()` factory function
 * in fields/factories.ts. See fields/factories.test.ts for table tests.
 */

import { describe, expect, test } from 'bun:test';
import { type Icon, normalizeIcon } from '../schema/fields/types';

describe('normalizeIcon', () => {
	test('plain emoji string → Icon tagged string', () => {
		const result = normalizeIcon('📝');
		expect(result).toBe('emoji:📝');
	});

	test('plain emoji string with unicode → Icon tagged string', () => {
		const result = normalizeIcon('🚀');
		expect(result).toBe('emoji:🚀');
	});

	test('Icon tagged string input → unchanged', () => {
		const icon: Icon = 'emoji:📝';
		const result = normalizeIcon(icon);
		expect(result).toBe('emoji:📝');
	});

	test('lucide Icon input → unchanged', () => {
		const icon: Icon = 'lucide:file-text';
		const result = normalizeIcon(icon);
		expect(result).toBe('lucide:file-text');
	});

	test('url Icon input → unchanged', () => {
		const icon: Icon = 'url:https://example.com/icon.png';
		const result = normalizeIcon(icon);
		expect(result).toBe('url:https://example.com/icon.png');
	});

	test('null input → null', () => {
		expect(normalizeIcon(null)).toBeNull();
	});

	test('undefined input → null', () => {
		expect(normalizeIcon(undefined)).toBeNull();
	});
});
