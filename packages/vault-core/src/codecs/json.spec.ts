import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { jsonFormat } from './json';

describe('JSON', () => {
	test('stringify converts Date objects into {$date}', () => {
		const input = { exportedAt: new Date('1970-01-01T00:00:00.000Z') };

		const out = jsonFormat.stringify(input);
		const parsed = JSON.parse(out);

		// Validate structure and type
		assert.ok(typeof parsed.exportedAt.$date === 'string');
		assert.strictEqual(parsed.exportedAt.$date, '1970-01-01T00:00:00.000Z');
	});

	test('parse revives {$date} back to a real Date', () => {
		const text = JSON.stringify({
			exportedAt: { $date: '2020-01-02T03:04:05.000Z' },
		});
		const revived = jsonFormat.parse(text);

		assert.ok(revived.exportedAt instanceof Date);
		assert.strictEqual(
			revived.exportedAt.toISOString(),
			'2020-01-02T03:04:05.000Z',
		);
	});
});
