/**
 * Keyboard logic helpers. These operate on the static key vocabularies in
 * `$lib/constants/keyboard` but are behavior, not data, so they live here.
 */
import {
	FUNCTION_KEY_PATTERN,
	KEYBOARD_EVENT_SUPPORTED_KEYS,
	type KeyboardEventPossibleKey,
	type KeyboardEventSupportedKey,
} from '$lib/constants/keyboard';

/**
 * Type guard that validates whether a KeyboardEventPossibleKey (any key from
 * the browser) is one of our chosen supported keys. When this returns true,
 * TypeScript narrows KeyboardEventPossibleKey to KeyboardEventSupportedKey.
 *
 * @param key - Any key value from KeyboardEvent.key.toLowerCase()
 */
export function isSupportedKey(
	key: KeyboardEventPossibleKey,
): key is KeyboardEventSupportedKey {
	return KEYBOARD_EVENT_SUPPORTED_KEYS.includes(
		key as KeyboardEventSupportedKey,
	);
}

/**
 * Maps macOS Option+Key special characters to their base keyboard keys.
 * When Option (Alt) is held on macOS, pressing keys produces special characters
 * instead of the normal key events. This mapping normalizes them back.
 */
const OPTION_KEY_CHARACTER_MAP = {
	// Option + Letters (A-Z)
	å: 'a', // Option+A
	'∫': 'b', // Option+B
	ç: 'c', // Option+C
	'∂': 'd', // Option+D
	ƒ: 'f', // Option+F (E is accent modifier)
	'©': 'g', // Option+G
	'˙': 'h', // Option+H
	'∆': 'j', // Option+J (I is accent modifier)
	'˚': 'k', // Option+K
	'¬': 'l', // Option+L
	µ: 'm', // Option+M
	ø: 'o', // Option+O (N is accent modifier)
	π: 'p', // Option+P
	œ: 'q', // Option+Q
	'®': 'r', // Option+R
	ß: 's', // Option+S
	'†': 't', // Option+T
	'√': 'v', // Option+V (U is accent modifier)
	'∑': 'w', // Option+W
	'≈': 'x', // Option+X
	'¥': 'y', // Option+Y
	Ω: 'z', // Option+Z

	// Option + Numbers
	º: '0', // Option+0
	'¡': '1', // Option+1
	'™': '2', // Option+2
	'£': '3', // Option+3
	'¢': '4', // Option+4
	'•': '8', // Option+8 (5,6,7 don't produce special chars)
	ª: '9', // Option+9

	// Option + Punctuation
	'"': '[', // Option+[
	"'": ']', // Option+]
	'\u2013': '-', // Option+- (en dash)
	'÷': '/', // Option+/
	'≥': '.', // Option+.
	'≤': ',', // Option+,
} as const satisfies Record<string, KeyboardEventPossibleKey>;

/**
 * Normalizes macOS Option+Key special characters back to their base keys, so
 * shortcuts work when Option is held (e.g. Option+A produces 'å').
 *
 * @param key - The key from the keyboard event (already lowercased)
 * @returns The normalized key ('å' -> 'a') or the original if not a special character
 */
export function normalizeOptionKeyCharacter(
	key: KeyboardEventPossibleKey,
): KeyboardEventPossibleKey {
	// Only process single characters (multi-char keys like 'alt', 'enter' pass through)
	if (key.length !== 1) return key;

	const normalizedKey =
		key in OPTION_KEY_CHARACTER_MAP
			? OPTION_KEY_CHARACTER_MAP[key as keyof typeof OPTION_KEY_CHARACTER_MAP]
			: null;
	return normalizedKey ?? key;
}

/**
 * Display labels for browser keys that need human-readable representation.
 * Exhaustive mapping for all non-trivial keys.
 */
const BROWSER_KEY_DISPLAY_LABELS = {
	// Whitespace
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
} as const satisfies Partial<Record<KeyboardEventSupportedKey, string>>;

/**
 * Gets the human-readable display label for a full shortcut string.
 *
 * @param shortcut - The shortcut string (e.g., "control+shift+ ", "a")
 * @returns Human-readable display (e.g., "Ctrl + Shift + Space", "A")
 */
export function getShortcutDisplayLabel(shortcut: string | null): string {
	if (!shortcut) return '';

	return shortcut
		.split('+')
		.map((key) => formatKeyForDisplay(key.toLowerCase()))
		.join(' + ');
}

/** Internal helper: formats a single key for display. */
function formatKeyForDisplay(key: string): string {
	const label =
		key in BROWSER_KEY_DISPLAY_LABELS
			? BROWSER_KEY_DISPLAY_LABELS[
					key as keyof typeof BROWSER_KEY_DISPLAY_LABELS
				]
			: null;
	if (label) return label;

	// Single letters: uppercase
	if (key.length === 1 && key >= 'a' && key <= 'z') {
		return key.toUpperCase();
	}

	// Function keys: uppercase (f1 -> F1)
	if (FUNCTION_KEY_PATTERN.test(key)) {
		return key.toUpperCase();
	}

	// Fallback for unknown multi-char keys: capitalize first letter
	if (key.length > 1) {
		return key.charAt(0).toUpperCase() + key.slice(1);
	}

	// Single char non-letters (numbers, punctuation): return as-is
	return key;
}
