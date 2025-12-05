import type { KeyboardEventSupportedKey } from './browser/supported-keys';

/**
 * Display labels for browser keys that need human-readable representation.
 * Exhaustive mapping for all non-trivial keys.
 */
const BROWSER_KEY_DISPLAY_LABELS: Partial<
	Record<KeyboardEventSupportedKey, string>
> = {
	// Whitespace (PRIMARY FIX)
	' ': 'Space',
	enter: 'Enter',
	tab: 'Tab',

	// Modifiers
	control: 'Ctrl',
	shift: 'Shift',
	alt: 'Alt',
	meta: 'Cmd',
	altgraph: 'AltGr',
	capslock: 'CapsLock',
	numlock: 'NumLock',
	scrolllock: 'ScrollLock',
	fn: 'Fn',
	fnlock: 'FnLock',
	super: 'Super',

	// Navigation
	arrowleft: '←',
	arrowright: '→',
	arrowup: '↑',
	arrowdown: '↓',
	home: 'Home',
	end: 'End',
	pageup: 'PgUp',
	pagedown: 'PgDn',

	// Editing
	backspace: '⌫',
	delete: 'Del',
	insert: 'Ins',
	clear: 'Clear',
	copy: 'Copy',
	cut: 'Cut',
	paste: 'Paste',
	redo: 'Redo',
	undo: 'Undo',

	// Special
	escape: 'Esc',
	contextmenu: 'Menu',
	pause: 'Pause',
	break: 'Break',
	printscreen: 'PrtSc',
	help: 'Help',

	// Media
	mediaplaypause: 'Play/Pause',
	mediaplay: 'Play',
	mediapause: 'Pause',
	mediastop: 'Stop',
	mediatracknext: 'Next Track',
	mediatrackprevious: 'Prev Track',
	volumeup: 'Vol+',
	volumedown: 'Vol-',
	volumemute: 'Mute',

	// Other keys
	dead: 'Dead',
	compose: 'Compose',
	accept: 'Accept',
	again: 'Again',
	attn: 'Attn',
	cancel: 'Cancel',
	execute: 'Execute',
	find: 'Find',
	finish: 'Finish',
	props: 'Props',
	select: 'Select',
	zoomout: 'Zoom Out',
	zoomin: 'Zoom In',
};

/**
 * Gets display label for a full shortcut string.
 *
 * @param shortcut - The shortcut string (e.g., "control+shift+ ", "a")
 * @returns Human-readable display (e.g., "Ctrl+Shift+Space", "A")
 *
 * @example
 * getShortcutDisplayLabel(' ')           // 'Space'
 * getShortcutDisplayLabel('control+a')   // 'Ctrl+A'
 * getShortcutDisplayLabel(null)          // ''
 */
export function getShortcutDisplayLabel(shortcut: string | null): string {
	if (!shortcut) return '';

	return shortcut
		.split('+')
		.map((key) => formatKeyForDisplay(key.toLowerCase()))
		.join('+');
}

/**
 * Internal helper: formats a single key for display.
 */
function formatKeyForDisplay(key: string): string {
	const label = BROWSER_KEY_DISPLAY_LABELS[key as KeyboardEventSupportedKey];
	if (label) return label;

	// Single letters: uppercase
	if (key.length === 1 && key >= 'a' && key <= 'z') {
		return key.toUpperCase();
	}

	// Function keys: uppercase (f1 -> F1)
	if (/^f\d{1,2}$/.test(key)) {
		return key.toUpperCase();
	}

	// Fallback for unknown multi-char keys: capitalize first letter
	if (key.length > 1) {
		return key.charAt(0).toUpperCase() + key.slice(1);
	}

	// Single char non-letters (numbers, punctuation): return as-is
	return key;
}
