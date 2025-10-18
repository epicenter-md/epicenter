export type { AcceleratorPossibleKey } from './accelerator/possible-keys';

export {
	ACCELERATOR_KEY_CODES,
	ACCELERATOR_MODIFIER_KEYS,
	ACCELERATOR_SECTIONS,
	type AcceleratorKeyCode,
	type AcceleratorModifier,
} from './accelerator/supported-keys';

export type { KeyboardEventPossibleKey } from './browser/possible-keys';

export {
	isSupportedKey,
	KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS,
	KEYBOARD_EVENT_SUPPORTED_KEYS,
	type KeyboardEventSupportedKey,
} from './browser/supported-keys';

export {
	normalizeOptionKeyCharacter,
	OPTION_DEAD_KEYS,
} from './macos-option-key-map';

export { CommandOrAlt, CommandOrControl } from './modifiers';
