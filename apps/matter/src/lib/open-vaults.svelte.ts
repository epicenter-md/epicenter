/**
 * The set of open vaults: the tabs.
 *
 * Multi-vault state is split three ways, and this file owns only the durable slice.
 * WHICH vault is active lives in the URL (`/vault/[id]`); the LIVE watcher lives in
 * the route component (construct on mount, dispose on destroy). All that is left is
 * WHICH folders are open: a small persisted list of `{ id, path, folderName }` that
 * survives relaunch so the tabs come back. The `id` is opaque and URL-safe so the
 * route can carry it; `/vault/[id]` resolves it back to a `path` via {@link get}.
 *
 * Replaces the old `vaultSession` singleton: where that held ONE `current` vault and
 * drove its lifetime, this holds only the list of tabs and the open/close actions.
 * SvelteKit's router owns everything else, so there is no `Map<id, Vault>`, no
 * `activeId`, and no manual dispose policy here.
 *
 * Single-context: the list is read once at construction and written on each change,
 * with no cross-window `storage` sync (the desktop app is one webview). A future
 * multi-window build (Open Q4) would add a `storage` listener here so the windows
 * agree on the open set.
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';

/** One open vault as persisted: an opaque id, the absolute folder path, its basename label. */
export type OpenVault = { id: string; path: string; folderName: string };

const STORAGE_KEY = 'matter.open-vaults';

/** A folder's basename (the tab label). Per-file paths stay Rust's; this is folder-level. */
const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;

/** Prompt for a folder; `null` if the dialog was cancelled. */
async function openFolderDialog(): Promise<string | null> {
	const path = await openDialog({
		directory: true,
		multiple: false,
		title: 'Open vault folder',
	});
	// A folder path is a string; null (cancel), an array (multi-select), or anything
	// else a future plugin version might return is "no pick".
	if (typeof path !== 'string') return null;
	return path;
}

/** Is `value` a list we can trust? A corrupt or stale store degrades to no tabs. */
function isOpenVaultList(value: unknown): value is OpenVault[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry): entry is OpenVault =>
				typeof entry === 'object' &&
				entry !== null &&
				typeof (entry as OpenVault).id === 'string' &&
				typeof (entry as OpenVault).path === 'string' &&
				typeof (entry as OpenVault).folderName === 'string',
		)
	);
}

/** Read the persisted list once at construction; a malformed store reads as no tabs. */
function loadPersisted(): OpenVault[] {
	if (!browser) return [];
	const raw = localStorage.getItem(STORAGE_KEY);
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return isOpenVaultList(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function createOpenVaults() {
	// The list IS the tabs, in order. Persisted on every change so relaunch restores it.
	let vaults = $state<OpenVault[]>(loadPersisted());

	function persist(): void {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(vaults));
	}

	/**
	 * Open a folder as a tab and navigate to it. Opening is always a user action: the
	 * native picker cannot be triggered from a URL, so this mints the id the URL will
	 * carry. Reopening a folder already in the list focuses its existing tab instead of
	 * duplicating it (tabs show one at a time and only the active one is live, so a
	 * second tab on the same folder would be a dead duplicate).
	 */
	async function open(): Promise<void> {
		const path = await openFolderDialog();
		if (path === null) return;
		const existing = vaults.find((vault) => vault.path === path);
		if (existing) {
			await goto(`/vault/${existing.id}`);
			return;
		}
		// Opaque, URL-safe, collision-free: the URL carries this, not the raw path (paths
		// contain `/` and special chars that are fragile in a URL).
		const vault: OpenVault = {
			id: crypto.randomUUID(),
			path,
			folderName: basename(path),
		};
		vaults = [...vaults, vault];
		persist();
		await goto(`/vault/${vault.id}`);
	}

	/**
	 * Remove a tab. Navigating away from a closed ACTIVE tab is the caller's job (the
	 * tab strip's `closeTab` goto()s a neighbor). That is what keeps the invariant "the
	 * viewed id is always in the list" true: the route's `load` resolves id -> path once
	 * and is not reactive to this list, so a removal that did NOT navigate would leave a
	 * now-orphaned vault live until the next navigation.
	 */
	function close(id: string): void {
		vaults = vaults.filter((vault) => vault.id !== id);
		persist();
	}

	/** Resolve an id back to its open vault, or `undefined` if it is not open. */
	function get(id: string): OpenVault | undefined {
		return vaults.find((vault) => vault.id === id);
	}

	return {
		/** The open vaults, in tab order. */
		get list(): OpenVault[] {
			return vaults;
		},
		open,
		close,
		get,
	};
}

export const openVaults = createOpenVaults();
