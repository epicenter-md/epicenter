import {
	isRegistered as tauriIsRegistered,
	register as tauriRegister,
	unregister as tauriUnregister,
	unregisterAll as tauriUnregisterAll,
} from '@tauri-apps/plugin-global-shortcut';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import * as os from '@tauri-apps/plugin-os';
import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { ShortcutEventState } from '$lib/commands';
import {
	ACCELERATOR_KEY_CODES,
	ACCELERATOR_MODIFIER_KEYS,
	ACCELERATOR_MODIFIER_SORT_PRIORITY,
	ACCELERATOR_PUNCTUATION_KEYS,
	type AcceleratorKeyCode,
	type AcceleratorModifier,
	FUNCTION_KEY_PATTERN,
	KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP,
	type KeyboardEventSupportedKey,
} from '$lib/constants/keyboard';

const ShortcutError = defineErrors({
	InvalidFormat: ({ accelerator }: { accelerator: string }) => ({
		message: `Invalid accelerator format: '${accelerator}'. Must follow Electron accelerator specification.`,
		accelerator,
	}),
	NoKeyCode: () => ({
		message: 'No valid key code found in pressed keys',
	}),
	MultipleKeyCodes: () => ({
		message: 'Multiple key codes not allowed in accelerator',
	}),
	GeneratedInvalid: ({ accelerator }: { accelerator: string }) => ({
		message: `Generated invalid accelerator: ${accelerator}`,
		accelerator,
	}),
	RegisterFailed: ({
		accelerator,
		cause,
	}: {
		accelerator: string;
		cause: unknown;
	}) => ({
		message: `Failed to register global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
		accelerator,
		cause,
	}),
	UnregisterFailed: ({
		accelerator,
		cause,
	}: {
		accelerator: string;
		cause: unknown;
	}) => ({
		message: `Failed to unregister global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
		accelerator,
		cause,
	}),
	UnregisterAllFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to unregister all global shortcuts: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type ShortcutError = InferErrors<typeof ShortcutError>;
type InvalidAcceleratorError =
	| InferError<typeof ShortcutError.InvalidFormat>
	| InferError<typeof ShortcutError.NoKeyCode>
	| InferError<typeof ShortcutError.MultipleKeyCodes>
	| InferError<typeof ShortcutError.GeneratedInvalid>;
type GlobalShortcutServiceError =
	| InferError<typeof ShortcutError.RegisterFailed>
	| InferError<typeof ShortcutError.UnregisterFailed>
	| InferError<typeof ShortcutError.UnregisterAllFailed>;

/**
 * A type that represents a global shortcut accelerator.
 *
 * @example
 * ```typescript
 * const accelerator: Accelerator = 'CommandOrControl+P';
 * ```
 *
 * @see https://www.electronjs.org/docs/latest/api/accelerator
 */
export type Accelerator = string & Brand<'Accelerator'>;

export const GlobalShortcutManagerLive = {
	async register({
		accelerator,
		callback,
		on,
		passthrough,
	}: {
		accelerator: Accelerator;
		callback: (state: ShortcutEventState) => void;
		on: ShortcutEventState[];
		passthrough?: boolean;
	}): Promise<
		Result<void, InvalidAcceleratorError | GlobalShortcutServiceError>
	> {
		const { error: unregisterError } =
			await GlobalShortcutManagerLive.unregister(accelerator);
		if (unregisterError) return Err(unregisterError);

		if (!isValidElectronAccelerator(accelerator)) {
			return ShortcutError.InvalidFormat({ accelerator });
		}

		const { error: registerError } = await tryAsync({
			try: () =>
				tauriRegister(accelerator, async (event) => {
					if (on.includes(event.state)) {
						// Check if we are currently simulating keys to avoid infinite loops
						const isSimulating = await tauriInvoke<boolean>(
							'get_is_simulating',
						);
						if (isSimulating) return;

						callback(event.state);

						if (passthrough) {
							// Perform passthrough: Unregister -> Simulate -> Re-register
							// We re-register immediately after simulation starts/ends
							// The get_is_simulating flag will protect us from the event
							// that arrives while the keys are being simulated.
							await GlobalShortcutManagerLive.unregister(accelerator);
							await tauriInvoke('simulate_accelerator', { accelerator });
							await GlobalShortcutManagerLive.register({
								accelerator,
								callback,
								on,
								passthrough,
							});
						}
					}
				}),
			catch: (error) =>
				ShortcutError.RegisterFailed({ accelerator, cause: error }),
		});
		/**
		 * NOTE: We often get "RegisterEventHotKey failed for <key>" errors when
		 * registering global shortcuts, even though the shortcut was valid and
		 * registered successfully. This is a known issue with the underlying system
		 * API on certain platforms. We gracefully return Ok(undefined) in these
		 * cases to avoid propagating the error as an unnecessary error toast,
		 * allowing the shortcut system to continue functioning for other valid keys.
		 */
		if (registerError) return Ok(undefined);

		return Ok(undefined);
	},

	/**
	 * Unregisters a global shortcut by ID.
	 * This function is idempotent - it can be safely called even if the shortcut
	 * with the given ID doesn't exist or has already been unregistered.
	 */
	async unregister(
		accelerator: Accelerator,
	): Promise<Result<void, GlobalShortcutServiceError>> {
		const isRegistered = await tauriIsRegistered(accelerator);
		if (!isRegistered) return Ok(undefined);

		const { error: unregisterError } = await tryAsync({
			try: () => tauriUnregister(accelerator),
			catch: (error) =>
				ShortcutError.UnregisterFailed({ accelerator, cause: error }),
		});
		if (unregisterError) return Err(unregisterError);
		return Ok(undefined);
	},

	/**
	 * Unregisters all global shortcuts.
	 * This function is idempotent - it can be safely called even if no shortcuts
	 * are currently registered.
	 */
	async unregisterAll(): Promise<Result<void, GlobalShortcutServiceError>> {
		const { error: unregisterAllError } = await tryAsync({
			try: () => tauriUnregisterAll(),
			catch: (error) => ShortcutError.UnregisterAllFailed({ cause: error }),
		});
		if (unregisterAllError) return Err(unregisterAllError);
		return Ok(undefined);
	},
};

export type GlobalShortcutManager = typeof GlobalShortcutManagerLive;

/**
 * Validates if a string is a valid Electron accelerator
 */
export function isValidElectronAccelerator(accelerator: string): boolean {
	const parts = accelerator.split('+');
	if (parts.length === 0) return false;

	const modifiers = parts.slice(0, -1);
	const lastPart = parts.at(-1);

	// Last part must be a key code (exclude modifiers)
	const isLastPartValidKeyCode = ACCELERATOR_KEY_CODES.includes(
		lastPart as AcceleratorKeyCode,
	);
	if (!isLastPartValidKeyCode) return false;

	// All other parts must be modifiers
	for (const modifier of modifiers) {
		if (!ACCELERATOR_MODIFIER_KEYS.includes(modifier as AcceleratorModifier))
			return false;
	}

	// Check for duplicate modifiers
	const uniqueModifiers = new Set(modifiers);
	const hasDuplicateModifiers = uniqueModifiers.size !== modifiers.length;
	if (hasDuplicateModifiers) return false;

	return true;
}

/**
 * Convert pressed keys directly to Tauri accelerator format
 */
export function pressedKeysToTauriAccelerator(
	pressedKeys: KeyboardEventSupportedKey[],
): Result<Accelerator, InvalidAcceleratorError> {
	const modifiers: AcceleratorModifier[] = [];
	const keyCodes: AcceleratorKeyCode[] = [];

	for (const key of pressedKeys) {
		const modifier = convertToModifier(key);
		if (modifier) {
			modifiers.push(modifier);
		} else {
			const keyCode = convertToKeyCode(key);
			if (keyCode) {
				keyCodes.push(keyCode);
			}
		}
	}

	// Must have exactly one key code
	if (keyCodes.length === 0) {
		return ShortcutError.NoKeyCode();
	}
	if (keyCodes.length > 1) {
		return ShortcutError.MultipleKeyCodes();
	}

	// Sort modifiers in standard order for consistency
	const sortedModifiers = sortModifiers(modifiers);

	// Build accelerator
	const accelerator = [...sortedModifiers, keyCodes.at(0)].join(
		'+',
	) as Accelerator;

	// Final validation
	if (!isValidElectronAccelerator(accelerator)) {
		return ShortcutError.GeneratedInvalid({ accelerator });
	}

	return Ok(accelerator);
}

/**
 * Converts a browser KeyboardEvent.key value (lowercase) to an Electron Accelerator modifier.
 *
 * This function handles platform-specific differences in how modifier keys are represented:
 * - Browser normalizes platform keys (e.g., Command key → "meta", Option key → "alt")
 * - Electron expects platform-specific modifiers (e.g., "Command" on macOS, "Super" on Windows/Linux)
 *
 * @param key - The lowercase key value from a KeyboardEvent (e.g., "control", "alt", "meta")
 * @returns The corresponding Electron Accelerator modifier, or null if the key is not a modifier
 *
 * @example
 * // On macOS
 * convertToModifier('meta') // Returns 'Command'
 * convertToModifier('alt')  // Returns 'Option'
 *
 * @example
 * // On Windows/Linux
 * convertToModifier('meta') // Returns 'Super'
 * convertToModifier('alt')  // Returns 'Alt'
 *
 * @example
 * // Cross-platform
 * convertToModifier('control') // Returns 'Control' on all platforms
 * convertToModifier('shift')   // Returns 'Shift' on all platforms
 * convertToModifier('space')   // Returns null (not a modifier)
 */
function convertToModifier(
	key: KeyboardEventSupportedKey,
): AcceleratorModifier | null {
	const platform = os.type();

	switch (key) {
		case 'control':
			// Control key is consistent across all platforms
			return 'Control';

		case 'shift':
			// Shift key is consistent across all platforms
			return 'Shift';

		case 'alt':
			// Alt key is called "Option" on macOS in Electron accelerators
			return platform === 'macos' ? 'Option' : 'Alt';

		case 'meta':
			// Meta key maps differently based on platform:
			// - macOS: Command key (reported as "meta" by browser)
			// - Windows/Linux: Windows/Super key (reported as "meta" by browser)
			return platform === 'macos' ? 'Command' : 'Super';

		case 'altgraph':
			// AltGr is not available on macOS
			return platform === 'macos' ? null : 'AltGr';

		// These keys might be reported by browsers but aren't standard Electron modifiers
		case 'super':
			// "super" as a key value (different from Meta) maps to Super modifier
			return 'Super';

		case 'fn':
			// These are not supported as Electron accelerator modifiers
			return null;

		default:
			// Any other key is not a modifier
			return null;
	}
}

/**
 * Convert a key to an Electron key code (returns null if invalid)
 */
function convertToKeyCode(
	key: KeyboardEventSupportedKey,
): AcceleratorKeyCode | null {
	// Single letters - convert to uppercase
	if (key.length === 1 && key >= 'a' && key <= 'z') {
		return key.toUpperCase() as AcceleratorKeyCode;
	}

	// Numbers - return as-is
	if (key.length === 1 && key >= '0' && key <= '9') {
		return key as AcceleratorKeyCode;
	}

	// Function keys - convert to uppercase
	if (FUNCTION_KEY_PATTERN.test(key)) {
		return key.toUpperCase() as AcceleratorKeyCode;
	}

	// Special key mappings (arrows, whitespace, media keys, etc.)
	const mappedKey = KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP[key];
	if (mappedKey) {
		return mappedKey;
	}

	// Punctuation and symbols - valid as-is
	if (
		ACCELERATOR_PUNCTUATION_KEYS.includes(
			key as (typeof ACCELERATOR_PUNCTUATION_KEYS)[number],
		)
	) {
		return key as AcceleratorKeyCode;
	}

	// Key not supported as an accelerator key code
	return null;
}

/**
 * Sort modifiers in a standard order for consistency
 * Order: CommandOrControl/Ctrl, Alt, Shift, Meta (if separate)
 */
function sortModifiers(
	modifiers: AcceleratorModifier[],
): AcceleratorModifier[] {
	return [...modifiers].sort((a, b) => {
		const priorityA = ACCELERATOR_MODIFIER_SORT_PRIORITY[a] ?? 99;
		const priorityB = ACCELERATOR_MODIFIER_SORT_PRIORITY[b] ?? 99;
		return priorityA - priorityB;
	});
}
