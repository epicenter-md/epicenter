import { describe, expect, it, mock } from 'bun:test';

// Mock platform constant before loading ffmpeg
mock.module('$lib/constants/platform', () => ({
	PLATFORM_TYPE: 'windows',
}));

// Mock other modules that might cause issues in Bun environment
mock.module('@tauri-apps/api/core', () => ({
	invoke: mock(() => {}),
}));

mock.module('@tauri-apps/api/path', () => ({
	join: mock(() => {}),
}));

mock.module('@tauri-apps/plugin-fs', () => ({
	exists: mock(() => {}),
	remove: mock(() => {}),
	stat: mock(() => {}),
}));

mock.module('@tauri-apps/plugin-shell', () => ({
	Child: class {
		kill = mock(() => {});
	},
}));

mock.module('@epicenter/svelte', () => ({
	createPersistedState: mock(() => ({
		current: null,
	})),
}));

// Mock services that might be imported
mock.module('$lib/services/desktop/command', () => ({
	asShellCommand: (s: string) => s,
	CommandServiceLive: {},
}));

mock.module('$lib/services/desktop/fs', () => ({
	FsServiceLive: {},
}));

// Now import parseDevices and asDeviceIdentifier
const { parseDevices } = await import('./ffmpeg');
const { asDeviceIdentifier } = await import('$lib/services/types');

describe('ffmpeg parseDevices (Windows)', () => {
	it('should parse modern DirectShow audio devices (with [dshow] prefix)', () => {
		const output = `
[dshow @ 00000164eeb0e380] DirectShow video devices (some may be both video and audio devices)
[dshow @ 00000164eeb0e380] "Generic USB Video Device" (video)
[dshow @ 00000164eeb0e380]   Alternative name "@device_pnp_\\\\?\\\\usb#vid_0000&pid_0000&mi_00#0&0000000&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[dshow @ 00000164eeb0e380] DirectShow audio devices
[dshow @ 00000164eeb0e380] "External Microphone" (audio)
[dshow @ 00000164eeb0e380]   Alternative name "@device_cm_{00000000-0000-0000-0000-000000000000}\\wave_{00000000-0000-0000-0000-000000000000}"
[dshow @ 00000164eeb0e380] "Internal Microphone" (audio)
[dshow @ 00000164eeb0e380]   Alternative name "@device_cm_{00000000-0000-0000-0000-000000000000}\\wave_{00000000-0000-0000-0000-000000000000}"
		`;

		const devices = parseDevices(output);

		expect(devices).toHaveLength(2);
		expect(devices[0]).toEqual({
			id: asDeviceIdentifier('External Microphone'),
			label: 'External Microphone',
		});
		expect(devices[1]).toEqual({
			id: asDeviceIdentifier('Internal Microphone'),
			label: 'Internal Microphone',
		});
	});

	it('should parse legacy DirectShow audio devices (without [dshow] prefix)', () => {
		const output = `
DirectShow audio devices
  "Legacy Microphone" (audio)
		`;

		const devices = parseDevices(output);

		expect(devices).toHaveLength(1);
		expect(devices[0]).toEqual({
			id: asDeviceIdentifier('Legacy Microphone'),
			label: 'Legacy Microphone',
		});
	});

	it('should return empty array if no audio devices are found', () => {
		const output = `
[dshow @ 00000164eeb0e380] DirectShow video devices (some may be both video and audio devices)
[dshow @ 00000164eeb0e380] "Generic Camera" (video)
		`;

		const devices = parseDevices(output);

		expect(devices).toHaveLength(0);
	});
});
