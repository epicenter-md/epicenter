# Feature: Simulate Enter Keystroke After Transcription

## Context

From [GitHub Issue #720](https://github.com/EpicenterHQ/epicenter/issues/720):

> Is there a way to submit the enter key after a transcription is successfully pasted? Question for normal transcribe and also voice activated.

Users want an option to automatically press Enter after transcription is pasted. This is useful for chat applications where pressing Enter submits the message.

## Implementation Plan

### 1. Settings Schema Update (`settings.ts`)

- [ ] Add `'transcription.simulateEnterAfterOutput': z.boolean().default(false)`
- [ ] Add `'transformation.simulateEnterAfterOutput': z.boolean().default(false)`

### 2. Rust Command (`lib.rs`)

- [ ] Add new Tauri command `simulate_enter_keystroke` that:
  - Uses `enigo` to press and release the Enter/Return key
  - Handles all three platforms (macOS, Windows, Linux)

### 3. TextService Update

- [ ] Add `simulateEnterKeystroke()` method to `TextService` type in `types.ts`
- [ ] Implement in `desktop.ts`: Calls Tauri command `simulate_enter_keystroke`
- [ ] Implement in `web.ts`: Returns error (browsers can't simulate keystrokes)
- [ ] Update `extension.ts` if needed

### 4. Text RPC Layer (`query/text.ts`)

- [ ] Add `simulateEnterKeystroke` query/mutation definition

### 5. Delivery Logic Update (`delivery.ts`)

- [ ] In `deliverTranscriptionResult`: After write-to-cursor succeeds and setting is enabled, call `simulateEnterKeystroke`
- [ ] In `deliverTransformationResult`: Same logic for transformation

Note: Enter should only be simulated when `writeToCursorOnSuccess` is enabled AND the new `simulateEnterAfterOutput` setting is enabled.

### 6. Settings UI (`settings/+page.svelte`)

- [ ] Add "Press Enter after pasting transcript" switch (under "Paste transcript at cursor")
- [ ] Add "Press Enter after pasting transformed text" switch (under "Paste transformed text at cursor")
- [ ] These switches should only be visible/enabled when their parent "Paste..." setting is enabled

## Technical Notes

### Enigo Enter Key Implementation

```rust
// Enter key on all platforms
let enter_key = Key::Return;

enigo.key(enter_key, Direction::Press)?;
enigo.key(enter_key, Direction::Release)?;
```

### Flow Diagram

```
Recording → Transcription → Delivery
                              ↓
                    Check settings
                              ↓
          ┌─────────────────────────────────────┐
          │ copyToClipboardOnSuccess?           │
          │        ↓ yes                        │
          │    Copy to clipboard                │
          └─────────────────────────────────────┘
                              ↓
          ┌─────────────────────────────────────┐
          │ writeToCursorOnSuccess?             │
          │        ↓ yes                        │
          │    Write to cursor (paste)          │
          │        ↓                            │
          │ simulateEnterAfterOutput?           │
          │        ↓ yes                        │
          │    Simulate Enter keystroke         │
          └─────────────────────────────────────┘
```

## Review

### Changes Made

1. **Settings** (`apps/whispering/src/lib/settings/settings.ts`):
   - Added `transcription.simulateEnterAfterOutput` (default: false)
   - Added `transformation.simulateEnterAfterOutput` (default: false)

2. **Rust Command** (`apps/whispering/src-tauri/src/lib.rs`):
   - Added `simulate_enter_keystroke` Tauri command using `enigo` crate
   - Registered in command handler

3. **TextService**:
   - `types.ts`: Added `simulateEnterKeystroke()` method to type definition
   - `desktop.ts`: Implemented via Tauri `invoke('simulate_enter_keystroke')`
   - `web.ts`: Returns error (not supported in browsers)
   - `extension.ts`: Returns error (not supported in extensions) + added missing `readFromClipboard`

4. **Text RPC** (`apps/whispering/src/lib/query/text.ts`):
   - Added `simulateEnterKeystroke` mutation

5. **Delivery** (`apps/whispering/src/lib/query/delivery.ts`):
   - Both `deliverTranscriptionResult` and `deliverTransformationResult` now call `simulateEnterKeystroke` when:
     - Write to cursor succeeds
     - `simulateEnterAfterOutput` setting is enabled

6. **Settings UI** (`apps/whispering/src/routes/(app)/(config)/settings/+page.svelte`):
   - Added "Press Enter after pasting transcript" switch (transcription)
   - Added "Press Enter after pasting transformed text" switch (transformation)
   - Both only visible on desktop (`window.__TAURI_INTERNALS__`) when their parent paste setting is enabled

### Build Status

- TypeScript: Pre-existing type errors in the codebase (unrelated to this feature)
- Rust: Compiles successfully (only pre-existing unused import warning)
