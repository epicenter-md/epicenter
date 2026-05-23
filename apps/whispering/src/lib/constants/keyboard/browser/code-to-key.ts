import type { KeyboardEventPossibleKey } from './possible-keys';

/**
 * Translates a W3C `KeyboardEvent.code` (physical key position) to the
 * lowercase logical key value our supported-key set uses (the same form that
 * `e.key.toLowerCase()` would return on a US ANSI layout).
 *
 * The pipeline previously read `e.key` for everything, which captures the
 * character produced by the current keyboard layout: on FI ISO the physical
 * Semicolon-position key reports `e.key === 'Ö'`, which is not in the
 * supported set and gets silently dropped during recording. Using `e.code`
 * gives us the layout-independent physical position (`Semicolon`) which we
 * map back to the canonical `;` token. Downstream conversion
 * (`pressedKeysToTauriAccelerator`) then produces an accelerator like
 * `Command+Shift+;`, which Tauri's `plugin-global-shortcut` binds to the
 * same physical position the user pressed.
 *
 * Modifier codes (ShiftLeft/Right, ControlLeft/Right, AltLeft/Right,
 * MetaLeft/Right, OSLeft/Right, AltGraph) intentionally return `null` so
 * callers fall back to `e.key`, which already reports the canonical modifier
 * name (`Shift`, `Control`, ...) consistently across platforms.
 *
 * Returns `null` for unknown codes so the caller can fall back to `e.key`.
 */
export function codeToLogicalKey(
	code: string,
): KeyboardEventPossibleKey | null {
	// Letters: KeyA..KeyZ → a..z
	if (code.startsWith('Key') && code.length === 4) {
		return code.slice(3).toLowerCase() as KeyboardEventPossibleKey;
	}
	// Top-row digits: Digit0..Digit9 → 0..9
	if (code.startsWith('Digit') && code.length === 6) {
		return code.slice(5) as KeyboardEventPossibleKey;
	}
	// Numpad digits: Numpad0..Numpad9 → 0..9 (lose numlock distinction; matches e.key with NumLock on)
	if (code.startsWith('Numpad') && code.length === 7) {
		const last = code.slice(6);
		if (last >= '0' && last <= '9') return last as KeyboardEventPossibleKey;
	}
	// Function keys: F1..F24 (as-is, lowercased)
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
		return code.toLowerCase() as KeyboardEventPossibleKey;
	}
	return SPECIAL_CODE_MAP[code] ?? null;
}

const SPECIAL_CODE_MAP: Record<string, KeyboardEventPossibleKey> = {
	// Whitespace
	Space: ' ',
	Enter: 'enter',
	NumpadEnter: 'enter',
	Tab: 'tab',
	// Editing
	Backspace: 'backspace',
	Delete: 'delete',
	Insert: 'insert',
	Escape: 'escape',
	// Navigation
	ArrowUp: 'arrowup',
	ArrowDown: 'arrowdown',
	ArrowLeft: 'arrowleft',
	ArrowRight: 'arrowright',
	Home: 'home',
	End: 'end',
	PageUp: 'pageup',
	PageDown: 'pagedown',
	// Punctuation: canonical US-ANSI character regardless of current layout
	Minus: '-',
	Equal: '=',
	BracketLeft: '[',
	BracketRight: ']',
	Backslash: '\\',
	Semicolon: ';',
	Quote: "'",
	Backquote: '`',
	Comma: ',',
	Period: '.',
	Slash: '/',
	// Numpad operators
	NumpadAdd: '+',
	NumpadSubtract: '-',
	NumpadMultiply: '*',
	NumpadDivide: '/',
	NumpadDecimal: '.',
	// Misc
	CapsLock: 'capslock',
	NumLock: 'numlock',
	ScrollLock: 'scrolllock',
	ContextMenu: 'contextmenu',
	PrintScreen: 'printscreen',
	Pause: 'pause',
};
