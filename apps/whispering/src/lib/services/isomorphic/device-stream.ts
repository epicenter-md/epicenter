import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import { WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS } from '$lib/constants/audio';
import type {
	Device,
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
	UpdateStatusMessageFn,
} from '$lib/services/types';
import { asDeviceIdentifier } from '$lib/services/types';

const { DeviceStreamServiceError, DeviceStreamServiceErr } = createTaggedError(
	'DeviceStreamServiceError',
);
type DeviceStreamServiceError = ReturnType<typeof DeviceStreamServiceError>;

/**
 * Check if we already have microphone permissions granted.
 * Uses Permissions API if available, otherwise returns false to trigger proper permission flow.
 */
async function hasExistingAudioPermission(): Promise<boolean> {
	// Try the Permissions API first (not all browsers support it)
	if ('permissions' in navigator) {
		const { data: permissionStatus, error } = await tryAsync({
			try: async () => {
				const permissionStatus = await navigator.permissions.query({
					name: 'microphone',
				});
				return permissionStatus;
			},
			catch: (error) =>
				DeviceStreamServiceErr({
					message: `We need permission to see your microphones. Check your browser settings and try again. ${extractErrorMessage(error)}`,
				}),
		});
		if (!error) return permissionStatus.state === 'granted';
	}

	// Return false to let the actual getUserMedia call handle permissions
	// This avoids unnecessary stream creation just for checking
	return false;
}

export async function enumerateDevices(): Promise<
	Result<Device[], DeviceStreamServiceError>
> {
	const hasPermission = await hasExistingAudioPermission();
	if (!hasPermission) {
		// extension.openWhisperingTab({});
	}
	return tryAsync({
		try: async () => {
			const allAudioDevicesStream = await navigator.mediaDevices.getUserMedia({
				audio: WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS,
			});
			const devices = await navigator.mediaDevices.enumerateDevices();
			for (const track of allAudioDevicesStream.getTracks()) {
				track.stop();
			}
			const audioInputDevices = devices.filter(
				(device) => device.kind === 'audioinput',
			);
			// On Web: Return Device objects with both ID and label
			const deviceList = audioInputDevices.map((device) => ({
				id: asDeviceIdentifier(device.deviceId),
				label: device.label,
			}));

			// Prepend "System Default" as the first option
			deviceList.unshift({
				id: asDeviceIdentifier('default'),
				label: 'System Default',
			});

			return deviceList;
		},
		catch: (error) =>
			DeviceStreamServiceErr({
				message: `We need permission to see your microphones. Check your browser settings and try again. ${extractErrorMessage(error)}`,
			}),
	});
}

/**
 * Get a media stream for a specific device identifier
 * @param deviceIdentifier - The device identifier
 *   - On Web: This is the deviceId (unique identifier)
 *   - On Desktop: This is the device name
 */
async function getStreamForDeviceIdentifier(
	deviceIdentifier: DeviceIdentifier,
) {
	const hasPermission = await hasExistingAudioPermission();
	if (!hasPermission) {
		// extension.openWhisperingTab({});
	}
	return tryAsync({
		try: async () => {
			// On Web: deviceIdentifier IS the deviceId, use it directly
			// Special case: if deviceIdentifier is "default", omit deviceId to use system default
			const audioConstraints =
				deviceIdentifier === 'default'
					? WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS
					: {
							...WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS,
							deviceId: { exact: deviceIdentifier },
						};

			const stream = await navigator.mediaDevices.getUserMedia({
				audio: audioConstraints,
			});
			return stream;
		},
		catch: (error) =>
			DeviceStreamServiceErr({
				message: `Unable to connect to the selected microphone. This could be because the device is already in use by another application, has been disconnected, or lacks proper permissions. Please check that your microphone is connected, not being used elsewhere, and that you have granted microphone permissions. ${extractErrorMessage(error)}`,
			}),
	});
}

export async function getRecordingStream({
	selectedDeviceId,
	sendStatus,
}: {
	selectedDeviceId: DeviceIdentifier | null;
	sendStatus: UpdateStatusMessageFn;
}): Promise<
	Result<
		{ stream: MediaStream; deviceOutcome: DeviceAcquisitionOutcome },
		DeviceStreamServiceError
	>
> {
	// Try preferred device first if specified
	if (!selectedDeviceId) {
		// No device selected
		sendStatus({
			title: '🔍 No Device Selected',
			description:
				"No worries! We'll find the best microphone for you automatically...",
		});
	} else {
		sendStatus({
			title: '🎯 Connecting Device',
			description:
				'Almost there! Just need your permission to use the microphone...',
		});

		const { data: preferredStream, error: getPreferredStreamError } =
			await getStreamForDeviceIdentifier(selectedDeviceId);

		if (!getPreferredStreamError) {
			return Ok({
				stream: preferredStream,
				deviceOutcome: { outcome: 'success', deviceId: selectedDeviceId },
			});
		}

		// We reach here if the preferred device failed, so we'll fall back to the first available device
		sendStatus({
			title: '⚠️ Finding a New Microphone',
			description:
				"That microphone isn't working. Let's try finding another one...",
		});
	}

	// Try to get any available device as fallback
	const getFirstAvailableStream = async (): Promise<
		Result<
			{ stream: MediaStream; deviceId: DeviceIdentifier },
			DeviceStreamServiceError
		>
	> => {
		const { data: devices, error: enumerateDevicesError } =
			await enumerateDevices();
		if (enumerateDevicesError)
			return DeviceStreamServiceErr({
				message:
					'Error enumerating recording devices and acquiring first available stream. Please make sure you have given permission to access your audio devices',
			});

		for (const device of devices) {
			const { data: stream, error } = await getStreamForDeviceIdentifier(
				device.id,
			);
			if (!error) {
				return Ok({ stream, deviceId: device.id });
			}
		}

		return DeviceStreamServiceErr({
			message: 'Unable to connect to any available microphone',
		});
	};

	// Get fallback stream
	const { data: fallbackStreamData, error: getFallbackStreamError } =
		await getFirstAvailableStream();
	if (getFallbackStreamError) {
		const errorMessage = selectedDeviceId
			? "We couldn't connect to any microphones. Make sure they're plugged in and try again!"
			: "Hmm... We couldn't find any microphones to use. Check your connections and try again!";
		return DeviceStreamServiceErr({
			message: errorMessage,
		});
	}

	// Return the stream with appropriate device outcome
	if (!selectedDeviceId) {
		return Ok({
			stream: fallbackStreamData.stream,
			deviceOutcome: {
				outcome: 'fallback',
				reason: 'no-device-selected',
				deviceId: fallbackStreamData.deviceId,
			},
		});
	}
	return Ok({
		stream: fallbackStreamData.stream,
		deviceOutcome: {
			outcome: 'fallback',
			reason: 'preferred-device-unavailable',
			deviceId: fallbackStreamData.deviceId,
		},
	});
}

export function cleanupRecordingStream(stream: MediaStream) {
	for (const track of stream.getTracks()) {
		track.stop();
	}
}
