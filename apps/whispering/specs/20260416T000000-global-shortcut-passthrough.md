# Global Shortcut Passthrough (Non-consuming Hotkeys)

## Problem
Currently, global shortcuts in Whispering are **exclusive and consuming**. This is because `tauri-plugin-global-shortcut` (and the underlying OS APIs like `RegisterHotKey` on Windows) intercepts the keyboard event and prevents it from propagating to other applications. This prevents users from using the same hotkey for both Whispering and another app (e.g., muting Discord while toggling Whispering).

## Proposed Solution: The "Unregister-Simulate-Re-register" Loop
Since OS-level hotkeys are inherently exclusive, we will implement a "re-play" mechanism:
1. When a global shortcut is triggered, Whispering executes its internal command.
2. If "Passthrough" is enabled for that shortcut:
    - Whispering **unregisters** the global hotkey.
    - Whispering **simulates** the same key combination using the `enigo` crate (already used in the project).
    - Whispering **re-registers** the global hotkey after a short delay (to ensure it doesn't catch its own simulated input).

## Implementation Details

### Wave 1: Rust Backend (Tauri Commands)
- **File:** `apps/whispering/src-tauri/src/lib.rs`
- **Task:** Implement `simulate_accelerator` command.
- **Logic:**
    - Parse the Electron-style accelerator string (e.g., `Control+Shift+D`).
    - Use `enigo` to simulate the key sequence:
        1. Press modifiers.
        2. Click the main key.
        3. Release modifiers.
- **Verification:** Create a small test script to verify `enigo` correctly simulates keys that other apps can hear.

### Wave 2: State and Persistence
- **File:** `apps/whispering/src/lib/state/device-config.svelte.ts`
- **Task:** Add a single global `.passthrough` setting for all global shortcuts.
- **Key Pattern:** `shortcuts.global.passthrough`.
- **Default:** `false` (opt-in).

### Wave 3: Service Layer Logic
- **File:** `apps/whispering/src/lib/services/desktop/global-shortcut-manager.ts`
- **Task:** Update the `register` method to support passthrough logic.
- **Logic:**
    - The callback provided to `tauriRegister` should check the passthrough setting.
    - If enabled:
        ```typescript
        async (event) => {
            // 1. Execute original callback
            callback(event.state);
            
            // 2. Perform Passthrough
            if (passthroughEnabled) {
                // Check if we are currently simulating keys to avoid infinite loops
                const isSimulating = await tauriInvoke<boolean>('get_is_simulating');
                if (isSimulating) return;

                await unregister(accelerator);
                await invoke('simulate_accelerator', { accelerator });
                // Immediately re-register; the simulation flag protects us from self-triggering
                await register({ accelerator, callback, on, passthrough: true });
            }
        }
        ```

### Wave 4: UI Integration
- **File:** `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/global/+page.svelte`
- **Task:** Add a centralized "Global Passthrough" toggle switch.
- **UX:** 
    - Title: "Global Passthrough"
    - Description: "Allows other applications to receive global shortcuts at the same time. This works by temporarily unregistering the hotkey, simulating the press, and re-registering."
    - Behavior: When toggled, trigger `syncGlobalShortcutsWithSettings()` to apply the change to all registered shortcuts immediately.

## Risks & Considerations
- **Infinite Loops:** If re-registration happens too quickly, Whispering might catch its own simulated input. A ~100ms delay is usually sufficient.
- **macOS Permissions:** `enigo` requires "Accessibility" permissions on macOS to simulate key presses. Whispering already requests this for its "Write Text" feature, so it should be fine.
- **Timing:** Different OSs have different event propagation speeds; the "unregister/re-register" window needs to be robust.
