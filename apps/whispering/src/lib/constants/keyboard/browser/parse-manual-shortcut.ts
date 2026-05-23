import type { KeyboardEventPossibleKey } from './possible-keys';
import { isSupportedKey, type KeyboardEventSupportedKey } from './supported-keys';

/**
 * User-friendly aliases that map to canonical W3C key names (the lowercase
 * form `e.key.toLowerCase()` produces). Lets the user type the names they
 * actually know (`ctrl`, `cmd`, `option`, `space`, `esc`) instead of memorising
 * the W3C set.
 */
const ALIAS_MAP: Record<string, KeyboardEventPossibleKey> = {
	// Modifiers
	ctrl: 'control',
	control: 'control',
	cmd: 'meta',
	command: 'meta',
	'⌘': 'meta',
	meta: 'meta',
	win: 'meta',
	super: 'meta',
	option: 'alt',
	opt: 'alt',
	'⌥': 'alt',
	alt: 'alt',
	shift: 'shift',
	'⇧': 'shift',
	altgr: 'altgraph',
	altgraph: 'altgraph',
	// Common named keys
	space: ' ',
	spacebar: ' ',
	esc: 'escape',
	escape: 'escape',
	ret: 'enter',
	return: 'enter',
	enter: 'enter',
	tab: 'tab',
	bs: 'backspace',
	backspace: 'backspace',
	del: 'delete',
	delete: 'delete',
	ins: 'insert',
	insert: 'insert',
	home: 'home',
	end: 'end',
	pgup: 'pageup',
	pageup: 'pageup',
	pgdn: 'pagedown',
	pagedown: 'pagedown',
	up: 'arrowup',
	down: 'arrowdown',
	left: 'arrowleft',
	right: 'arrowright',
	arrowup: 'arrowup',
	arrowdown: 'arrowdown',
	arrowleft: 'arrowleft',
	arrowright: 'arrowright',
};

function aliasToCanonical(token: string): KeyboardEventPossibleKey | null {
	const t = token.trim().toLowerCase();
	if (!t) return null;
	const mapped = ALIAS_MAP[t];
	if (mapped) return mapped;
	// Pass-through: letters, digits, punctuation, function keys, etc.
	// isSupportedKey downstream validates that the token is actually usable.
	return t as KeyboardEventPossibleKey;
}

/**
 * Parses a `+`-separated manual shortcut entry like `"ctrl+shift+a"` or
 * `"cmd+option+space"` into a list of canonical keys plus any tokens that
 * could not be normalised. The recorder UI surfaces `invalidTokens` as a
 * validation error so the user gets honest feedback instead of the legacy
 * "silently drop unrecognised tokens" behaviour.
 */
export function parseManualShortcut(input: string): {
	keys: KeyboardEventSupportedKey[];
	invalidTokens: string[];
} {
	const tokens = input
		.split('+')
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	const keys: KeyboardEventSupportedKey[] = [];
	const invalidTokens: string[] = [];
	for (const token of tokens) {
		const canonical = aliasToCanonical(token);
		if (canonical && isSupportedKey(canonical)) {
			keys.push(canonical);
		} else {
			invalidTokens.push(token);
		}
	}
	return { keys, invalidTokens };
}
