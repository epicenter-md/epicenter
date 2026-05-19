import { expect } from 'bun:test';
import type { Result } from 'wellcrafted/result';

export function expectOk<T>(result: Result<T, unknown>): T {
	expect(result.error).toBeNull();
	if (result.error !== null) throw result.error;
	return result.data as T;
}

export function expectErr<E>(result: Result<unknown, E>): E {
	expect(result.error).not.toBeNull();
	if (result.error === null) throw new Error('Expected Err result');
	return result.error;
}
