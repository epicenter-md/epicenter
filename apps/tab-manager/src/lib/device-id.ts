/**
 * Device ID utilities for multi-device tab sync.
 *
 * Provides stable device identification and composite ID helpers
 * for scoping browser tab/window/group IDs to specific devices.
 */

import { generateId } from '@epicenter/hq/dynamic';
import { storage } from '@wxt-dev/storage';

// ─────────────────────────────────────────────────────────────────────────────
// Device ID Storage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device ID storage item.
 * Auto-generates a NanoID on first access if not already set.
 */
const deviceIdItem = storage.defineItem<string>('local:deviceId', {
	init: () => generateId(),
});

/**
 * Get the stable device ID for this browser installation.
 * Generated once on first install, persisted in storage.local.
 */
export async function getDeviceId(): Promise<string> {
	// getValue() can technically return null if storage fails, but our init
	// function ensures a value is always generated. Assert non-null here.
	const deviceId = await deviceIdItem.getValue();
	if (!deviceId) {
		throw new Error('Device ID not found - storage may have failed');
	}
	return deviceId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser & OS Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the current browser name from WXT environment.
 */
export function getBrowserName(): string {
	return import.meta.env.BROWSER; // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
}

/**
 * Capitalize first letter of a string.
 */
function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Generate a default device name like "Chrome on macOS".
 */
export async function generateDefaultDeviceName(): Promise<string> {
	const browserName = capitalize(import.meta.env.BROWSER);
	const platformInfo = await browser.runtime.getPlatformInfo();
	const osName = (
		{
			mac: 'macOS',
			win: 'Windows',
			linux: 'Linux',
			cros: 'ChromeOS',
			android: 'Android',
			openbsd: 'OpenBSD',
			fuchsia: 'Fuchsia',
		} satisfies Record<Browser.runtime.PlatformInfo['os'], string>
	)[platformInfo.os];
	return `${browserName} on ${osName}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite ID Parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal helper to parse a composite ID.
 */
function parseCompositeIdInternal(
	compositeId: string,
): { deviceId: string; nativeId: number } | null {
	const idx = compositeId.indexOf('_');
	if (idx === -1) return null;

	const deviceId = compositeId.slice(0, idx);
	const nativeId = Number.parseInt(compositeId.slice(idx + 1), 10);

	if (Number.isNaN(nativeId)) return null;

	return { deviceId, nativeId };
}

/**
 * Parse a composite tab ID into its parts.
 * @example parseTabId('abc123_456') // { deviceId: 'abc123', tabId: 456 }
 */
export function parseTabId(
	compositeId: string,
): { deviceId: string; tabId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, tabId: result.nativeId };
}

/**
 * Parse a composite window ID into its parts.
 * @example parseWindowId('abc123_456') // { deviceId: 'abc123', windowId: 456 }
 */
export function parseWindowId(
	compositeId: string,
): { deviceId: string; windowId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, windowId: result.nativeId };
}

/**
 * Parse a composite group ID into its parts.
 * @example parseGroupId('abc123_456') // { deviceId: 'abc123', groupId: 456 }
 */
export function parseGroupId(
	compositeId: string,
): { deviceId: string; groupId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, groupId: result.nativeId };
}
