import { expect, test } from 'bun:test';
import { COMPILED_APPLICATIONS, listApplications } from './applications.ts';

test('Home lists only release-compiled applications', () => {
	expect(listApplications()).toEqual([...COMPILED_APPLICATIONS]);
});
