import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { fromTaggedErr, type WhisperingError } from '$lib/result';
import * as services from '$lib/services';
import { defineMutation } from './_client';

const setTrayIconKeys = {
	setTrayIcon: ['setTrayIcon', 'setTrayIcon'] as const,
};

export const tray = {
	setTrayIcon: defineMutation({
		mutationKey: setTrayIconKeys.setTrayIcon,
		resultMutationFn: async ({
			icon,
		}: {
			icon: WhisperingRecordingState;
		}): Promise<Result<void, WhisperingError>> => {
			const { data, error } = await services.tray.setTrayIcon(icon);

			if (error) {
				return fromTaggedErr(error, {
					title: '⚠️ Failed to set tray icon',
					action: { type: 'more-details', error },
				});
			}

			return Ok(data);
		},
	}),
};
