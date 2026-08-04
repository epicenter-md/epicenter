/**
 * This device's identity: an install-stable node id plus a default label.
 *
 * The Data runtime has no node identity to offer, so the extension owns this
 * fact outright. The id is minted once and kept in `chrome.storage.local`, which
 * makes it stable across side panel opens, browser restarts, and sign-in state,
 * and distinct per browser profile. Rows stamp it as `sourceNodeId` so a saved
 * tab can say which device saved it, and the `devices` table turns it into
 * something a person recognizes.
 *
 * Nothing here reads or writes durable rows; `registerDevice` takes an already
 * bound handle. That keeps this module inert at import.
 */

import { InstantString } from '@epicenter/field';
import { storage } from '@wxt-dev/storage';
import { nanoid } from 'nanoid';
import type { TabManagerData } from '$lib/workspace';

const nodeIdCell = storage.defineItem<string>('local:node.id');

/** This device's id and default label, read from (or minted into) local storage. */
export type DeviceProfile = {
	nodeId: string;
	defaultName: string;
};

/**
 * Resolve this device's profile, minting the node id on first run.
 *
 * A concurrent first run in two extension documents could mint twice; the
 * second write wins for later opens, while the first document keeps the id it
 * already read. The bounded cost is one orphan device row, never a lost or
 * duplicated saved tab.
 */
export async function createDeviceProfile(): Promise<DeviceProfile> {
	const [nodeId, defaultName] = await Promise.all([
		readOrMintNodeId(),
		generateDefaultDeviceName(),
	]);
	return { nodeId, defaultName };
}

async function readOrMintNodeId(): Promise<string> {
	const stored = await nodeIdCell.getValue();
	if (typeof stored === 'string' && stored.length > 0) return stored;
	const minted = nanoid();
	await nodeIdCell.setValue(minted);
	return minted;
}

/**
 * Record this device in the `devices` table: refresh `lastSeen` on the row this
 * node id already owns, or seed a new row with the default label.
 *
 * A rename lives on the row, so an existing row's `name` is never overwritten.
 */
export async function registerDevice(
	data: TabManagerData,
	{ nodeId, defaultName }: DeviceProfile,
): Promise<void> {
	const { rows } = await data.devices.scan();
	const existing = rows.find((device) => device.nodeId === nodeId);
	if (existing) {
		const updated = await data.devices.patch(existing.id, {
			lastSeen: InstantString.now(),
		});
		if (updated.error !== null) throw updated.error;
		return;
	}
	await data.devices.create({
		nodeId,
		name: defaultName,
		lastSeen: InstantString.now(),
		browser: import.meta.env.BROWSER,
	});
}

const capitalize = (value: string) =>
	value.charAt(0).toUpperCase() + value.slice(1);

/** Default device label like "Chrome on macOS". */
async function generateDefaultDeviceName(): Promise<string> {
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
