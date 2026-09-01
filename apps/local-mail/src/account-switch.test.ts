import { expect, test } from 'bun:test';
import { createAccountFolderSwitch } from './account-switch.ts';

test('account folder replacement requires explicit consent', () => {
	const folder = createAccountFolderSwitch('account-a');
	const refused = folder.request('account-b');
	expect(refused.error?.name).toBe('AccountFolderSwitchNeedsConsent');
	expect(folder.current()).toBe('account-a');

	const accepted = folder.request('account-b', true);
	expect(accepted.error).toBeNull();
	expect(folder.current()).toBe('account-b');
});
