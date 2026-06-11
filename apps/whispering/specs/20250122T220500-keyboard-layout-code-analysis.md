# e.code vs e.key: Keyboard Layout Implications

## What is e.code?

`e.code` represents the **physical location** of a key on the keyboard, while `e.key` represents the **character produced**.

### Example: QWERTY vs AZERTY

On a QWERTY keyboard:

- Physical key in top-left letter position: `e.code = 'KeyQ'`, `e.key = 'q'`

On an AZERTY (French) keyboard:

- Same physical key: `e.code = 'KeyQ'`, `e.key = 'a'`

## The Problem with e.code for International Users

Using `e.code` can be confusing for international users:

### Scenario 1: French User with AZERTY

- User wants to set shortcut "Cmd+A"
- They press Cmd + the 'A' key (where Q is on QWERTY)
- With `e.code`: Records as "Cmd+Q" ❌
- With `e.key`: Records as "Cmd+A" ✅

### Scenario 2: German User with QWERTZ

- User wants to set shortcut "Alt+Y"
- They press Alt + the 'Y' key (where Z is on QWERTY)
- With `e.code`: Records as "Alt+Z" ❌
- With `e.key`: Records as "Alt+Y" ✅

## When e.code Makes Sense

1. **Games**: WASD movement should work by position, not letter
2. **Physical key bindings**: "The key next to Tab" regardless of what it types
3. **Cross-layout consistency**: Same physical gesture across keyboards

## When e.key Makes Sense

1. **Mnemonic shortcuts**: Cmd+S for Save, Cmd+C for Copy
2. **User expectations**: The shortcut should match what's printed on the key
3. **International software**: Respects user's keyboard layout

## The Real Issue We're Solving

The problem isn't really about layouts. It's about macOS transforming keys:

- Option+A → 'å' (QWERTY)
- Option+Q → 'œ' (AZERTY)

Both layouts have the same core issue: Option changes the character.

## Better Solutions

### Solution 1: Minimal e.code Usage (Recommended)

Only use `e.code` to detect which key was pressed when `e.key` is unusable:

```typescript
function getKeyFromEvent(e: KeyboardEvent): string {
	const key = e.key.toLowerCase();

	// Only use code as fallback when key is unusable
	if (key === 'dead' || key === 'unidentified' || key === '') {
		// Extract from code but return the expected character for that layout
		return extractKeyFromCode(e.code, e);
	}

	return key;
}

function extractKeyFromCode(code: string, event: KeyboardEvent): string {
	// Use additional context to determine the right key
	// This is where it gets complex...

	// For letters, we could try to use the keyboard layout API
	// For now, fallback to physical position
	const match = code.match(/^Key([A-Z])$/);
	return match ? match[1].toLowerCase() : '';
}
```

### Solution 2: Stick with e.key + Character Normalization (Simpler)

This is actually what you already implemented! It's more predictable:

```typescript
if (isOptionPressed) {
	key = normalizeOptionKeyCharacter(key);
}
```

Pros:

- Respects keyboard layout
- Shows user what they actually pressed
- Only normalizes known Option combinations

Cons:

- Need to maintain character map
- Dead keys still problematic

### Solution 3: Smart Hybrid

Use `e.key` normally, but have fallbacks for known problems:

```typescript
let key = e.key.toLowerCase();

// Handle dead keys specifically
if (e.altKey && (key === 'dead' || key === '')) {
	// Only for dead keys, check common codes
	if (e.code === 'KeyE') key = 'e';
	else if (e.code === 'KeyI') key = 'i';
	else if (e.code === 'KeyN') key = 'n';
	else if (e.code === 'KeyU') key = 'u';
	// This is limited but predictable
} else if (e.altKey && key.length === 1) {
	// Normal Option combinations
	key = normalizeOptionKeyCharacter(key);
}
```

## Recommendation

**Don't use e.code as the primary key source.** It breaks international keyboard expectations.

Instead:

1. Use `e.key` as the primary source (respects layouts)
2. Normalize known Option+key special characters
3. Only use `e.code` as a fallback for dead keys when `e.key` is empty/unusable
4. Document that some Option combinations might not work on non-US keyboards

## The Ugly Truth

There's no perfect solution. Every approach has trade-offs:

- **e.key only**: Dead keys don't work
- **e.code only**: Wrong keys for international users
- **Hybrid**: Complex and still imperfect
- **Character normalization**: Maintenance burden but most predictable

Your current approach (character normalization) is actually quite good. The dead key problem is annoying but affects fewer users than breaking international keyboards would.
