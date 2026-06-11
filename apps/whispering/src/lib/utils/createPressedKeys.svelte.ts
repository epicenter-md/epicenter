import { on } from 'svelte/events';
import { os } from '#platform/os';
import {
	type KeyboardEventPossibleKey,
	type KeyboardEventSupportedKey,
} from '$lib/constants/keyboard';
import {
	isSupportedKey,
	normalizeOptionKeyCharacter,
} from '$lib/utils/keyboard';

/**
 * Creates a reactive state manager for tracking pressed keyboard keys.
 *
 * Uses pure `$state` for reactivity: array mutations (`.push()`, `.filter()`,
 * reassignment) signal Svelte through the proxy. Event listeners are cheap and
 * always wanted while the component is mounted, so `$effect` handles lifecycle
 * directly without `createSubscriber`.
 *
 * Features:
 * - Tracks currently pressed keys in lowercase format
 * - Prevents duplicate keys in the pressed state
 * - Handles special cases for modifier keys (meta, control, alt, shift)
 * - Clears pressed keys on window blur and tab visibility changes
 * - Automatically manages event listener cleanup via `$effect` teardown
 *
 * @returns An object with a `current` getter that returns the array of currently pressed keys
 *
 * @example
 * ```ts
 * // Default usage (prevents browser shortcuts)
 * const pressedKeys = createPressedKeys();
 *
 * // Allow browser shortcuts to work
 * const pressedKeys = createPressedKeys({ preventDefault: false });
 *
 * // In a reactive context
 * $effect(() => {
 *   console.log('Currently pressed:', pressedKeys.current);
 * });
 * ```
 */
export function createPressedKeys({
	preventDefault = true,
	onUnsupportedKey,
}: {
	/**
	 * Whether to call preventDefault() on keydown events.
	 * - true (default): Blocks browser shortcuts (e.g., Ctrl+S won't save the page)
	 * - false: Allows browser shortcuts to execute alongside key tracking
	 */
	preventDefault?: boolean;
	onUnsupportedKey?: (key: KeyboardEventPossibleKey) => void;
}) {
	/** Pressed and normalized keys. Only contains supported keys (filtered by isSupportedKey guard). */
	let pressedKeys = $state<KeyboardEventSupportedKey[]>([]);

	/**
	 * Sets up keyboard, blur, and visibility-change listeners to track pressed keys.
	 * Returns a teardown that removes all listeners and resets state.
	 */
	$effect(() => {
		const keydown = on(window, 'keydown', (e) => {
			if (preventDefault) {
				e.preventDefault();
			}
			let key = e.key.toLowerCase() as KeyboardEventPossibleKey;

			// macOS Option key normalization:
			// On macOS, the Option key (Alt) triggers special character insertion.
			// For example, Option+A produces "å" instead of registering as "alt+a".
			// This breaks keyboard shortcut detection because we get the special
			// character instead of the actual key that was pressed.
			//
			// To fix this, when Option is held on macOS, we normalize these special
			// characters back to their base keys (e.g., "å" → "a", "ç" → "c").
			// This ensures keyboard shortcuts work consistently across platforms.
			if (os.isApple && pressedKeys.includes('alt')) {
				key = normalizeOptionKeyCharacter(key);
			}

			if (!isSupportedKey(key)) {
				onUnsupportedKey?.(key);
				return;
			}

			if (!pressedKeys.includes(key)) {
				pressedKeys.push(key);
			}
		});

		const keyup = on(window, 'keyup', (e) => {
			const key = e.key.toLowerCase() as KeyboardEventPossibleKey;

			if (!isSupportedKey(key)) return;

			// Special handling for modifier keys (meta, control, alt, shift)
			// This addresses issues with OS/browser intercepting certain key combinations
			// where non-modifier keyup events might not fire properly
			if (
				key === 'meta' ||
				key === 'control' ||
				key === 'alt' ||
				key === 'shift'
			) {
				// When a modifier key is released, clear all non-modifier keys
				// but keep other modifier keys that might still be pressedKeys
				// This prevents keys from getting "stuck" in the pressedKeys state
				pressedKeys = pressedKeys.filter((k) => k !== key);
			}

			// Regular key removal
			pressedKeys = pressedKeys.filter((k) => k !== key);
		});

		// Handle window blur events (switching applications, clicking outside browser)
		// Reset all keys when user shifts focus away from the window
		const blur = on(window, 'blur', () => {
			pressedKeys = [];
		});

		// Handle tab visibility changes (switching browser tabs)
		// This catches cases where the window doesn't lose focus but the tab is hidden
		const visibilityChange = on(document, 'visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				pressedKeys = [];
			}
		});

		return () => {
			// Clear pressed keys to prevent "stuck" keys after teardown
			pressedKeys = [];
			keydown();
			keyup();
			blur();
			visibilityChange();
		};
	});

	return {
		/**
		 * Gets the current array of pressed keys.
		 *
		 * This getter is reactive - accessing it in a reactive context (like $effect)
		 * will cause that context to re-run whenever the pressed keys change.
		 *
		 * @returns Array of currently pressed key names in lowercase
		 */
		get current() {
			return pressedKeys;
		},
	};
}

export type PressedKeys = ReturnType<typeof createPressedKeys>;
