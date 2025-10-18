import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { Ok, tryAsync } from 'wellcrafted/result';
import { IS_MACOS } from '$lib/constants/platform';

export const { PermissionsServiceError, PermissionsServiceErr } =
	createTaggedError('PermissionsServiceError');
export type PermissionsServiceError = ReturnType<
	typeof PermissionsServiceError
>;

export type PermissionsService = {
	accessibility: {
		check: () => Promise<Result<boolean, PermissionsServiceError>>;
		request: () => Promise<Result<unknown, PermissionsServiceError>>;
	};
	microphone: {
		check: () => Promise<Result<boolean, PermissionsServiceError>>;
		request: () => Promise<Result<unknown, PermissionsServiceError>>;
	};
};

function createPermissionsService(): PermissionsService {
	return {
		accessibility: {
			async check() {
				if (!IS_MACOS) return Ok(true);

				return tryAsync({
					try: async () => {
						const { checkAccessibilityPermission } = await import(
							'tauri-plugin-macos-permissions-api'
						);
						return await checkAccessibilityPermission();
					},
					catch: (error) =>
						PermissionsServiceErr({
							message: `Failed to check accessibility permissions: ${extractErrorMessage(error)}`,
							cause: error,
						}),
				});
			},

			async request() {
				if (!IS_MACOS) return Ok(true);

				return tryAsync({
					try: async () => {
						const { requestAccessibilityPermission } = await import(
							'tauri-plugin-macos-permissions-api'
						);
						return await requestAccessibilityPermission();
					},
					catch: (error) =>
						PermissionsServiceErr({
							message: `Failed to request accessibility permissions: ${extractErrorMessage(error)}`,
							cause: error,
						}),
				});
			},
		},

		microphone: {
			async check() {
				if (!IS_MACOS) return Ok(true);

				return tryAsync({
					try: async () => {
						const { checkMicrophonePermission } = await import(
							'tauri-plugin-macos-permissions-api'
						);
						return await checkMicrophonePermission();
					},
					catch: (error) =>
						PermissionsServiceErr({
							message: `Failed to check microphone permissions: ${extractErrorMessage(error)}`,
							cause: error,
						}),
				});
			},

			async request() {
				if (!IS_MACOS) return Ok(true);

				return tryAsync({
					try: async () => {
						const { requestMicrophonePermission } = await import(
							'tauri-plugin-macos-permissions-api'
						);
						return await requestMicrophonePermission();
					},
					catch: (error) =>
						PermissionsServiceErr({
							message: `Failed to request microphone permissions: ${extractErrorMessage(error)}`,
							cause: error,
						}),
				});
			},
		},
	};
}

export const PermissionsServiceLive = createPermissionsService();
