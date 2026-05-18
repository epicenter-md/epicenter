export type { AcceleratorPossibleKey } from './accelerator/possible-keys';

export {
	ACCELERATOR_KEY_CODES,
	ACCELERATOR_MODIFIER_KEYS,
	ACCELERATOR_PUNCTUATION_KEYS,
	ACCELERATOR_SECTIONS,
	type AcceleratorKeyCode,
	type AcceleratorModifier,
} from './accelerator/supported-keys';

export {
	ACCELERATOR_MODIFIER_SORT_PRIORITY,
	KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP,
} from './accelerator-conversions';

export { codeToLogicalKey } from './browser/code-to-key';
export { parseManualShortcut } from './browser/parse-manual-shortcut';
export type { KeyboardEventPossibleKey } from './browser/possible-keys';

export {
	isSupportedKey,
	KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS,
	KEYBOARD_EVENT_SUPPORTED_KEYS,
	type KeyboardEventSupportedKey,
} from './browser/supported-keys';
export { getShortcutDisplayLabel } from './display-labels';
export {
	normalizeOptionKeyCharacter,
	OPTION_DEAD_KEYS,
} from './macos-option-key-map';
export { CommandOrAlt, CommandOrControl } from './modifiers';
export { FUNCTION_KEY_PATTERN } from './patterns';
