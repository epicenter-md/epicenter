import { Err, Ok, type Result } from 'wellcrafted/result';

export type AccountFolderSwitchError = {
	name: 'AccountFolderSwitchNeedsConsent';
	message: string;
	currentAccountId: string;
	requestedAccountId: string;
};

/** App-owned state for replacing the account represented by the `account` folder. */
export type AccountFolderSwitch = {
	request(accountId: string, consented?: boolean): Result<void, AccountFolderSwitchError>;
	current(): string | null;
};

export function createAccountFolderSwitch(
	initialAccountId: string | null = null,
): AccountFolderSwitch {
	let currentAccountId = initialAccountId;
	return {
		request(accountId, consented = false) {
			if (currentAccountId === null || currentAccountId === accountId) {
				currentAccountId = accountId;
				return Ok(undefined);
			}
			if (!consented) {
				return Err({
					name: 'AccountFolderSwitchNeedsConsent',
					message:
						`The account folder currently shows ${currentAccountId}. Switching to ${accountId} will replace that folder with the new account's mirror. Confirm to continue.`,
					currentAccountId,
					requestedAccountId: accountId,
				});
			}
			currentAccountId = accountId;
			return Ok(undefined);
		},
		current: () => currentAccountId,
	};
}
