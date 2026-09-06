/**
 * The two names an application mints.
 *
 * They are checked where they are minted rather than on every call (ADR-0339),
 * and the mint throws, because a name reaching it is a constant in a build.
 * This test moved here with the mints when the storage half left
 * `@epicenter/app`.
 */

import { expect, test } from 'bun:test';
import { databaseName, secretLabel } from './index.js';

test('a name is checked where it is minted, not on every call', () => {
	expect(() => databaseName('../mail')).toThrow('is not valid');
	expect(() => databaseName('Mail')).toThrow('is not valid');
	expect(String(databaseName('mail'))).toBe('mail');

	expect(() => secretLabel('../other')).toThrow('is not valid');
	expect(() => secretLabel('a/b')).toThrow('is not valid');
	expect(String(secretLabel('sub-one'))).toBe('sub-one');
});
