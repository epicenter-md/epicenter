import {
	asDeviceIdentifier,
	type CpalRecordingParams,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

const MANUAL_DEVICE_ID_KEY = 'recording.cpal.deviceId';

/**
 * Platform-resolved manual recorder settings for the Tauri build.
 *
 * Manual recording persists to the CPAL device key on desktop, while VAD keeps
 * using the Navigator key. This object is the single JS owner of that manual
 * device-key choice so UI, fallback persistence, and start-param resolution do
 * not repeat a runtime platform branch.
 */
export const manualRecorderConfig = {
	get deviceId(): string | null {
		return deviceConfig.get(MANUAL_DEVICE_ID_KEY);
	},

	set deviceId(deviceId: string | null) {
		deviceConfig.set(MANUAL_DEVICE_ID_KEY, deviceId);
	},

	/**
	 * Resolve persisted manual recorder settings into CPAL start params.
	 *
	 * The recorder service stays params-in and does not read Svelte state; this
	 * config boundary performs that app-level read immediately before starting.
	 */
	resolveStartParams(recordingId: string): CpalRecordingParams {
		const deviceId = this.deviceId;
		return {
			recordingId,
			selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
			sampleRate: deviceConfig.get('recording.cpal.sampleRate'),
		};
	},
};
