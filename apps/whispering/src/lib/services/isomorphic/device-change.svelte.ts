/**
 * Creates a device change listener for monitoring audio device changes
 * Works in both web (MediaDevices) and desktop (Tauri) environments
 */
export function createDeviceChangeListener() {
	let isSubscribed = false;
	let handler: (() => void) | null = null;

	function subscribe() {
		if (isSubscribed || !navigator.mediaDevices) {
			return;
		}

		// Subscribe to device changes (web only - desktop uses polling)
		if ('ondevicechange' in navigator.mediaDevices) {
			handler = () => {
				// Device change detected - queries will auto-refresh via enabled flag
				console.log('[DeviceChangeListener] Device change detected');
			};
			navigator.mediaDevices.addEventListener('devicechange', handler);
			isSubscribed = true;
		}
	}

	function unsubscribe() {
		if (handler && navigator.mediaDevices) {
			navigator.mediaDevices.removeEventListener('devicechange', handler);
		}
		isSubscribed = false;
		handler = null;
	}

	return {
		subscribe,
		unsubscribe,
	};
}
