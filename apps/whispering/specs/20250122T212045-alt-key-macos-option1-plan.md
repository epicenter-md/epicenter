# macOS Alt/Option Key Recording Fix - Implementation Plan

## Overview

Implement Solution 1: Track Alt state and normalize special characters by creating a comprehensive mapping of Option+Key combinations to their base keys.

## Todo List

- [ ] Create Option character mapping constant file with coercion function
- [ ] Modify createPressedKeys to use the coercion function
- [ ] Add tests for Option key combinations
- [ ] Test on macOS with various keyboards
- [ ] Ensure no regression on Windows/Linux

## Implementation Details

### 1. Create Option Character Mapping with Coercion Function

Create a new file: `src/lib/constants/_option-char-mappings.ts`

```typescript
// Map of special characters produced by Option+Key to their base keys
const OPTION_CHAR_TO_KEY_MAP: Record<string, string> = {
  // Option + Letters (A-Z)
  'å': 'a',  // Option+A
  '∫': 'b',  // Option+B
  'ç': 'c',  // Option+C
  '∂': 'd',  // Option+D
  // Note: Option+E is accent modifier, not a character
  'ƒ': 'f',  // Option+F
  '©': 'g',  // Option+G
  '˙': 'h',  // Option+H
  // Note: Option+I is accent modifier, not a character
  '∆': 'j',  // Option+J
  '˚': 'k',  // Option+K
  '¬': 'l',  // Option+L
  'µ': 'm',  // Option+M
  // Note: Option+N is accent modifier, not a character
  'ø': 'o',  // Option+O
  'π': 'p',  // Option+P
  'œ': 'q',  // Option+Q
  '®': 'r',  // Option+R
  'ß': 's',  // Option+S
  '†': 't',  // Option+T
  // Note: Option+U is accent modifier, not a character
  '√': 'v',  // Option+V
  '∑': 'w',  // Option+W
  '≈': 'x',  // Option+X
  '¥': 'y',  // Option+Y
  'Ω': 'z',  // Option+Z

  // Option + Numbers
  'º': '0',  // Option+0
  '¡': '1',  // Option+1
  '™': '2',  // Option+2
  '£': '3',  // Option+3
  '¢': '4',  // Option+4
  // Option+5, 6, 7 don't produce special characters
  '•': '8',  // Option+8
  'ª': '9',  // Option+9

  // Option + Special Keys
  '"': '[',  // Option+[
  ''': ']',  // Option+]
  '\u2013': '-',  // Option+- (en dash)
  '÷': '/',  // Option+/
  '≥': '.',  // Option+.
  '≤': ',',  // Option+,
};

/**
 * Coerces macOS Option+Key special characters back to their base keys.
 * This fixes the issue where Option+A produces 'å' instead of registering as 'alt+a'.
 *
 * @param key - The key from the keyboard event (already lowercased)
 * @returns The base key if it was a special character, or the original key
 */
export function coerceMacosKey(key: string): string {
  // Only coerce single-character keys that might be special characters
  if (key.length !== 1) return key;

  // Check if this is a known Option+Key special character
  return OPTION_CHAR_TO_KEY_MAP[key] ?? key;
}
```

### 2. Modify createPressedKeys

Update `src/lib/utils/createPressedKeys.svelte.ts`:

```typescript
import { coerceMacosKey } from '$lib/constants/_option-char-mappings';

export function createPressedKeys<
	TSupportedKey extends KeyboardEventPossibleKey,
>({
	supportedKeys,
	preventDefault = true,
	onUnsupportedKey,
}: {
	supportedKeys: TSupportedKey[];
	preventDefault?: boolean;
	onUnsupportedKey?: (key: KeyboardEventPossibleKey) => void;
}) {
	// ... existing code ...

	const subscribe = createSubscriber((update) => {
		const keydown = on(window, 'keydown', (e) => {
			if (preventDefault) {
				e.preventDefault();
			}

			let key = e.key.toLowerCase() as KeyboardEventPossibleKey;

			// Coerce macOS special characters when Alt is pressed
			const isAltPressed = pressedKeys.includes('alt' as TSupportedKey);
			if (isAltPressed) {
				key = coerceMacosKey(key) as KeyboardEventPossibleKey;
			}

			if (!isSupportedKey(key)) {
				onUnsupportedKey?.(key);
				return;
			}

			if (!pressedKeys.includes(key)) {
				pressedKeys.push(key);
			}
			update();
		});

		const keyup = on(window, 'keyup', (e) => {
			let key = e.key.toLowerCase() as KeyboardEventPossibleKey;

			// Coerce on keyup too for consistency
			const isAltPressed = pressedKeys.includes('alt' as TSupportedKey);
			if (isAltPressed) {
				key = coerceMacosKey(key) as KeyboardEventPossibleKey;
			}

			if (!isSupportedKey(key)) return;

			// ... existing modifier key handling and filtering ...
		});

		// ... rest of existing code ...
	});

	return {
		get current() {
			subscribe();
			return pressedKeys;
		},
	};
}
```

### 3. Benefits of This Approach

1. **Cleaner State Management**: No separate `isAltPressed` variable to maintain
2. **Testable**: The `coerceMacosKey` function can be easily unit tested
3. **Reusable**: The coercion logic can be used elsewhere if needed
4. **Minimal Changes**: Only adds a few lines to the existing code
5. **Self-Contained**: All the macOS-specific logic is isolated in one function

### 4. Testing Strategy

1. **Unit tests for coerceMacosKey**:

   ```typescript
   test('coerceMacosKey maps Option special characters', () => {
	expect(coerceMacosKey('å')).toBe('a');
	expect(coerceMacosKey('∫')).toBe('b');
	expect(coerceMacosKey('a')).toBe('a'); // unchanged
	expect(coerceMacosKey('alt')).toBe('alt'); // multi-char unchanged
   });
   ```

2. **Integration tests**:
   - Test all Option+Letter combinations
   - Test that order doesn't matter (Alt→A vs A→Alt)
   - Test rapid key combinations
   - Verify Windows/Linux behavior unchanged

## Edge Cases Handled

1. **Multi-character keys**: Only single characters are coerced (e.g., 'alt', 'enter' pass through)
2. **Unknown special characters**: Pass through unchanged via `??` operator
3. **Non-Alt combinations**: Only coerce when Alt is actually pressed
4. **Keyup consistency**: Apply same coercion on keyup to ensure proper key removal

## Review

This implementation elegantly solves the macOS Option+Key issue with minimal code changes and maximum clarity. The `coerceMacosKey` function encapsulates all the platform-specific logic, making it easy to understand, test, and maintain.
