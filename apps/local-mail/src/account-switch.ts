import { Err, Ok, type Result } from 'wellcrafted/result';

export type AccountFolderSwitchError = {
	name: 'AccountFolderSwitchNeedsConsent';
	message: string;
	currentSub: string;
	requestedSub: string;
};

/** App-owned state for replacing the account represented by the `account` folder. */
export type AccountFolderSwitch = {
	request(
		sub: string,
		consented?: boolean,
	): Result<void, AccountFolderSwitchError>;
	current(): string | null;
};

export function createAccountFolderSwitch(
	initialSub: string | null = null,
): AccountFolderSwitch {
	let currentSub = initialSub;
	return {
		request(sub, consented = false) {
			if (currentSub === null || currentSub === sub) {
				currentSub = sub;
				return Ok(undefined);
			}
			if (!consented) {
				return Err({
					name: 'AccountFolderSwitchNeedsConsent',
					message: `The account folder currently shows ${currentSub}. Switching to ${sub} will replace that folder with the new account's mirror. Confirm to continue.`,
					currentSub,
					requestedSub: sub,
				});
			}
			currentSub = sub;
			return Ok(undefined);
		},
		current: () => currentSub,
	};
}
