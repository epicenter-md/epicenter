# Whispering Hotkey Overhaul

**Date**: 2026-05-18
**Status**: Draft
**Author**: AI-assisted (with Mika Rummukainen)
**Branch**: TBD (suggested: `fix/whispering-hotkeys`)

## Overview

Make Whispering's hotkey system usable on non-US keyboard layouts and macOS by gating each hotkey subsystem (local, global) behind a user-facing toggle with local defaulting OFF, shipping a single sensible global default (Option+Space toggle), fixing the recorder's layout-blind capture, and surfacing registration errors that are currently swallowed. Local hotkeys stay in the codebase; users who want them can flip the switch on.

## Motivation

### Current State

Whispering ships two parallel hotkey subsystems, both bound to `window`:

```
                          window keydown / keyup
                                    │
                ┌───────────────────┴────────────────────┐
                ▼                                        ▼
   LocalShortcutManagerLive               createPressedKeys (recorder UI)
   local-shortcut-manager.ts:69-218       createPressedKeys.svelte.ts:60-136
   (registered at +layout.svelte:26)      (registered while popover is open)
```

Defaults at `src/routes/(app)/_layout-utils/register-commands.ts:15-40`:

```ts
const DEFAULT_LOCAL_SHORTCUTS = {
  pushToTalk: 'p', toggleManualRecording: ' ', cancelManualRecording: 'c',
  toggleVadRecording: 'v', openTransformationPicker: 't',
  runTransformationOnClipboard: 'r', ...
};

const DEFAULT_GLOBAL_SHORTCUTS = {
  pushToTalk: `${CommandOrAlt}+Shift+D`,
  toggleManualRecording: `${CommandOrControl}+Shift+;`,
  cancelManualRecording: `${CommandOrControl}+Shift+'`,
  openTransformationPicker: `${CommandOrControl}+Shift+X`,
  runTransformationOnClipboard: `${CommandOrControl}+Shift+R`,
  ...
};
```

Recorder capture pipeline:

```
e.key (layout-dependent character)
    │
    ▼ toLowerCase + Option-character map (US-only)
isSupportedKey(key)  ─── fails for ö/ä/etc. ───▶  onUnsupportedKey, dropped
    │
    ▼ pressedKeysToTauriAccelerator
convertToModifier switch:  cases are 'control' | 'shift' | 'alt' | 'meta' | ...
    │                      (no 'ctrl', 'cmd', 'command', 'option')
    ▼
tauriRegister(accelerator)  ─── any error is silently swallowed at line 125-133
```

This creates problems:

1. **Local shortcuts fire while editing global shortcuts.** Both listeners are siblings on `window`. The recorder popover focuses a `<button>`, not an input, so `isTypingInInput()` (`local-shortcut-manager.ts:278-312`) returns false. `preventDefault()` doesn't stop sibling listeners; `stopImmediatePropagation` is never called. Pressing keys to record a combo also triggers the local action bound to those keys.
2. **Finnish (and other non-US) layouts cannot record punctuation shortcuts.** `e.key` returns layout-dependent characters. On FI ISO, the physical Semicolon-position key produces `Ö`. `'ö'` is not in `OPTION_KEY_CHARACTER_MAP` (`macos-option-key-map.ts:9-50`, US-only) and not in `KEYBOARD_EVENT_SUPPORTED_KEYS`. The key is rejected, recording fails with `NoKeyCode`.
3. **Manual text entry silently drops aliases.** `KeyboardShortcutRecorder.svelte:197-199` does `manualValue.split('+') as KeyboardEventSupportedKey[]` with zero validation. `convertToModifier` (`global-shortcut-manager.ts:276-317`) is a case-sensitive switch with only the W3C key names (`control`/`shift`/`alt`/`meta`/...). User types matching the placeholder ("e.g., ctrl+shift+a") drop `ctrl`/`cmd`/`command`/`option` entirely, leaving the bare key as the accelerator.
4. **macOS Option dead keys (E, I, N, U, `) cannot be recorded.** The UI warns about this (`KeyboardShortcutRecorder.svelte:108`) but nothing handles it. `OPTION_DEAD_KEYS` is defined in code (`macos-option-key-map.ts:82`) and never imported anywhere.
5. **Registration failures are silently swallowed.** `global-shortcut-manager.ts:125-133` returns `Ok(undefined)` on every `tauriRegister` error. Real failures (OS-reserved combo, parser rejection, conflict) produce a "shortcut saved" UX with no actual binding.
6. **Default combos are US-layout-specific.** `Cmd+Shift+;`, `Cmd+Shift+'`, `Cmd+Shift+X` all assume US ANSI. On FI ISO, those physical positions produce different characters and the on-screen labels mean a different key than the one that will trigger.

### Desired State

Two opt-in subsystems with explicit settings toggles. Local hotkeys default OFF (most users don't need them and they cause bug #1's interference). Global hotkeys default ON. One sensible global default (Option+Space toggles recording). Recorder captures the physical key so layout doesn't matter. Manual entry accepts common aliases or rejects with a clear error. Registration failures surface as errors instead of "saved" lies.

```ts
// Target defaults
const DEFAULT_GLOBAL_SHORTCUTS = {
  toggleManualRecording: 'Alt+Space',  // platform-aliased to Option+Space on macOS
  // everything else: null. User adds combos they actually want.
};

// New settings entries
shortcuts.local.enabled  = false  // OFF by default
shortcuts.global.enabled = true   // ON by default
```

## Research Findings

### How other transcription apps handle this

| App | Toggle recording | Cancel | Notes |
| --- | --- | --- | --- |
| Superwhisper | Configurable; common: hold Fn or Option | Esc (window-local) | Single combo by default, holds and toggles |
| MacWhisper | Configurable; defaults to a function-row key | Window-local close | Aggressively avoids US-punctuation defaults |
| Wispr Flow | Hold Fn or Right Option | Releases on key-up | Single physical-key default |
| Whispering (current) | Cmd+Shift+; (US-only) | Cmd+Shift+' (US-only) | Plus four more defaults, plus local duplicates |

**Key finding**: Mature apps ship one default combo and leave the rest empty. They prefer modifier+space or modifier+function-key because both work on every Latin keyboard layout. None of them ship a default that depends on US-only punctuation positions.

**Implication**: Reducing defaults to one Alt+Space combo is the conservative, layout-portable choice and matches the dominant pattern in this category.

### What Tauri's `plugin-global-shortcut` actually expects

Underlying crate: `global-hotkey` (used by Tauri v2 plugin). Accelerator strings are parsed into a `HotKey` struct that uses W3C `KeyboardEvent.code` values for the non-modifier portion (`Semicolon`, `Minus`, `Space`, `KeyA`, etc.). These are **physical key positions**, not layout-dependent characters. The same physical key on US and FI keyboards has the same `code` even though `key` differs.

**Implication**: The capture path must use `e.code` (physical) for the non-modifier key, not `e.key` (logical). `e.key` is fine for the modifier keys themselves (`'Meta'`, `'Alt'`, etc.) and for the *displayed* label.

### What `KeyboardEvent.code` looks like on different physical keys

| Physical key | `e.code` | `e.key` on US | `e.key` on FI ISO |
| --- | --- | --- | --- |
| The "Semicolon" position | `Semicolon` | `;` / `:` | `ö` / `Ö` |
| The "Minus" position | `Minus` | `-` / `_` | `+` / `?` |
| Spacebar | `Space` | ` ` | ` ` |
| Letter A | `KeyA` | `a` / `A` | `a` / `A` |
| Left Option | `AltLeft` | `Alt` | `Alt` |

**Implication**: Capturing `e.code` and translating it back to a Tauri accelerator name (`KeyA` → `A`, `Semicolon` → `;`, `Minus` → `-`) gives consistent behavior across layouts. The displayed label can still use `e.key` so the user sees the character on their keycap.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Gate each hotkey subsystem behind a setting | 3 taste | Toggle (not removal) | User preference: preserve the code path for the minority who want local hotkeys; default local OFF, global ON. Symmetric so either can be disabled independently. |
| Default local hotkeys to OFF for new installs; grandfather existing users | 3 taste | Grandfather | User decided: existing users with at least one local shortcut configured keep local=ON; only fresh installs and users with no local shortcuts default to OFF. Preserves existing workflows; accepts that power users still face bug #2 until they discover the toggle. |
| Settings storage for the two new toggles | 2 coherence | Synced user settings | User decided: lives in the same store as `analytics.enabled` etc., not deviceConfig. Toggle is a preference, not a per-machine concern. |
| Capture key via `e.code` (physical) instead of `e.key` | 1 evidence | `e.code` | Verified that Tauri's `plugin-global-shortcut` uses W3C `code` namespace under the hood; `e.key` is layout-dependent. |
| Default global combo | 2 coherence | `Alt+Space` only | Matches Superwhisper/Wispr pattern; Alt+Space is unreserved on macOS/Win/Linux; no other defaults to reduce surprise. |
| Cancel-recording default combo | Deferred | Open question | Esc is unreliable as a global hotkey; needs explicit user call. See Open Questions. |
| Surface `tauriRegister` errors | 2 coherence | Stop swallowing | Current behavior misleads users; the "RegisterEventHotKey false-positive" claim is unsubstantiated. Show real errors. |
| Manual entry: alias map or restructured UI | Deferred | Open question | Two viable paths with different effort. See Open Questions. |
| Diagnostic logging | 3 taste | Add early, behind gate, remove or hide before merge | User asked for it; helps verify FI keyboard fix; gated by `import.meta.env.DEV` so production stays quiet. |
| macOS Option dead-key handling | 3 taste | Show clearer recorder message, do not invest in fix | Real fix requires reading `e.code` (already in scope for the layout fix), which incidentally resolves this. No extra work needed if Phase 2 lands. |
| Security hardening from prior audit | 2 coherence | Defer to separate branch | User explicitly scoped it out; not entangled with hotkey logic. |

## Architecture

### Before

```
window keydown/keyup
   │
   ├──▶ LocalShortcutManagerLive ──▶ shortcuts Map ──▶ in-app actions
   │    (always listening,                              (interferes with recorder)
   │     isTypingInInput guard
   │     misses non-input focus)
   │
   └──▶ createPressedKeys (recorder, when popover open)
        e.key.toLowerCase()  ──▶  pressedKeysToTauriAccelerator
                                    │
                                    ▼
                                 tauriRegister(accelerator) ──▶ OS
                                    error swallowed at line 125-133
```

### After

```
settings.shortcuts.local.enabled  (default false)
settings.shortcuts.global.enabled (default true)
                │
                ▼
window keydown/keyup
   │
   ├──▶ LocalShortcutManagerLive (only if local.enabled)
   │    same code as today; just conditionally mounted
   │
   └──▶ createPressedKeys (recorder, when popover open)
        e.code (physical)        ──▶ codeToAcceleratorKey (KeyA -> A, Semicolon -> ;)
        e.metaKey/altKey/...     ──▶ modifier list
                                    │
                                    ▼
                                 pressedKeysToTauriAccelerator
                                    │
                                    ▼
                                 tauriRegister(accelerator)         ──▶ OS
                                 (only if global.enabled at sync time)
                                    error: shown in toast with the actual cause
```

### File-by-file impact

```
NEW SETTINGS  shortcuts.local.enabled  : boolean = false
              shortcuts.global.enabled : boolean = true
              (added to settings schema; persist in synced user settings, not deviceConfig,
              so the preference travels with the user)

EDIT    src/routes/(app)/+layout.svelte
          wrap services.localShortcutManager.listen() in an $effect that reads
          settings.get('shortcuts.local.enabled') and starts/stops accordingly
EDIT    src/routes/(app)/(config)/settings/shortcuts/local/+page.svelte
          add a master Switch at the top of the local table; when off, show explainer
EDIT    src/routes/(app)/(config)/settings/shortcuts/global/+page.svelte
          same: master Switch for global; when off, unregister all and show explainer
EDIT    src/routes/(app)/_layout-utils/register-commands.ts
          syncLocalShortcutsWithSettings: early-return if local.enabled is false
          syncGlobalShortcutsWithSettings: early-return + unregisterAll if global.enabled is false
          shrink DEFAULT_GLOBAL_SHORTCUTS to { toggleManualRecording: 'Alt+Space' }
EDIT    src/lib/state/settings.svelte.ts (or equivalent)
          add the two new settings entries
EDIT    src/lib/utils/createPressedKeys.svelte.ts
          capture e.code-based key alongside (or instead of) e.key
EDIT    src/lib/services/desktop/global-shortcut-manager.ts
          (1) stop swallowing tauriRegister errors at line 125-133
          (2) accept code-derived keys in convertToKeyCode
EDIT    src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/KeyboardShortcutRecorder.svelte
          either: add alias normalization for manual entry
          or:    replace manual input with structured editor (see Open Questions)

KEEP    src/lib/services/local-shortcut-manager.ts (no changes)
KEEP    src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/LocalKeyboardShortcutRecorder.svelte
        (kept so users who flip local back on have a functional editor)
```

## Implementation Plan

Three phases, ordered for fastest user value:

- Phase 1: Gating (small, fully resolves bug #2 in the default-OFF case)
- Phase 2: Sensible default (small, gives FI users a working out-of-box combo)
- Phase 3: Capture pipeline fix (largest, unlocks custom combos on any layout)

Each phase is a separate PR / merge commit so any can be reverted independently.

### Phase 1: Gate hotkey subsystems behind toggles

Goal: stop the local listener from interfering with the recorder for the 95% of users who don't use local hotkeys, without removing the feature.

#### Wave 1.1: Add settings entries

- [x] **1.1.1** Added `shortcuts.local.enabled` (default `false`) and `shortcuts.global.enabled` (default `true`) to `apps/whispering/src/lib/workspace/definition.ts` in the `shortcuts` group.
- [x] **1.1.2** Entries flow through `whisperingKv` → `settings` store; reactive via the existing SvelteMap observer.

#### Wave 1.2: Gate the listeners

- [x] **1.2.1** `+layout.svelte` effect now reads `settings.get('shortcuts.local.enabled')` and only starts the listener when true. Cleanup returned conditionally.
- [x] **1.2.2** `syncLocalShortcutsWithSettings()` early-returns if local disabled. Map registrations are inert without the listener; flip back ON re-runs the sync.
- [x] **1.2.3** `syncGlobalShortcutsWithSettings()` calls `desktopRpc.globalShortcuts.unregisterAll()` and early-returns when global disabled, freeing OS hotkeys.
- [x] **1.2.4** Two `$effect`s in `AppLayout.svelte` re-run sync on toggle change.

#### Wave 1.3: UI toggles

- [x] **1.3.1** Master Switch added to `local/+page.svelte`. Table dimmed via `pointer-events-none opacity-50` when OFF. Reset-to-defaults button disabled when OFF.
- [x] **1.3.2** Same pattern in `global/+page.svelte`.
- [x] **1.3.3** Toggle changes propagate via reactive effects; no restart needed (pending manual verification by user).

#### Wave 1.4: Grandfather migration

- [x] **1.4.1** `grandfatherLocalShortcutsEnabled()` runs once via `whispering.shortcuts.local.enabled.grandfathered` localStorage marker. Detects existing users via `whispering.settings.migration === 'completed'` OR presence of the old `whispering-settings` blob (handles the async race with `migrateOldSettings`).
- [x] **1.4.2** Fresh installs match neither signal → stay at default `false`.

#### Wave 1.5: Verify

- [ ] **1.5.1** `bun run typecheck` and `bun run build` pass for `apps/whispering`. (User to run; bun not available in agent env.)
- [ ] **1.5.2** Manual smoke: fresh install → local tab shows OFF → open global shortcut editor → record a combo → no local action fires.
- [ ] **1.5.3** Manual smoke: flip local ON → set a local shortcut → confirm it fires.
- [ ] **1.5.4** Manual smoke: flip global OFF → confirm registered global shortcuts no longer fire systemwide → flip back ON → confirm they fire again.

Commit boundary: Phase 1 ships as one PR.

### Phase 2: Sensible default (Option+Space)

Goal: give the FI user (and everyone else on non-US layouts) a working default that doesn't depend on US punctuation positions.

- [ ] **2.1** In `register-commands.ts`, replace `DEFAULT_GLOBAL_SHORTCUTS` with `{ toggleManualRecording: 'Alt+Space' }`; set all other entries to `null`.
- [ ] **2.2** Verify the legacy-replacement code at `query/desktop/shortcuts.ts:25-28` leaves `Alt` as `Alt` on macOS (it should; Alt is the W3C name and Tauri's plugin handles platform rendering). If not, hardcode `Option+Space` for macOS.
- [ ] **2.3** Conditional migration: if the user's stored `shortcuts.global.toggleManualRecording` equals the literal old default (`Command+Shift+;`) AND registration for that combo failed on the last app start, reset it to the new default. (Less surprising than a blind reset; see Open Question 3.)
- [ ] **2.4** Update any docs/help text mentioning the old defaults.
- [ ] **2.5** Smoke-test on FI keyboard: fresh install → press Option+Space → recording toggles.

Commit boundary: Phase 2 ships as one PR.

### Phase 3: Fix global hotkey capture and surface errors

Goal: make recording work on FI (and any) layout, make manual entry honest, stop hiding errors.

#### Wave 3.1: Add diagnostic logging (gated by DEV)

- [ ] **3.1.1** In `createPressedKeys.svelte.ts`, log `{ key: e.key, code: e.code, metaKey, altKey, ctrlKey, shiftKey }` at the top of the keydown handler, gated by `import.meta.env.DEV`.
- [ ] **3.1.2** In `global-shortcut-manager.ts:125-133`, log the swallowed error (still swallow for now) so we can see what Tauri actually says when the user's FI keyboard tries to register the default combo.
- [ ] **3.1.3** User runs the app with these logs on, reports back what `e.key` and `e.code` look like for the FI keycaps they care about. (Out-of-band step; pause here for evidence before writing the fix.)

#### Wave 3.2: Switch capture to `e.code`-based key

- [ ] **3.2.1** Introduce a `codeToAcceleratorKey(code: string)` helper in `$lib/constants/keyboard/` that maps W3C `code` values to Tauri accelerator names (`KeyA` → `A`, `Digit5` → `5`, `Semicolon` → `;`, `Minus` → `-`, `Space` → `Space`, etc.). Reference: <https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_code_values>.
- [ ] **3.2.2** Modify `createPressedKeys.svelte.ts` to push the code-derived key for non-modifiers; keep using `e.key` for modifier detection (`'meta'`, `'alt'`, `'control'`, `'shift'`).
- [ ] **3.2.3** Display: in the recorder UI, label the captured key using the current `e.key` value so the user sees what is printed on their keycap. Store the code-derived value.
- [ ] **3.2.4** Verify FI user can now record `Cmd+Shift+the-Ö-physical-key` and have it stored as `Command+Shift+;` (which is what Tauri's plugin will match against the same physical key at runtime).

#### Wave 3.3: Honest manual entry

Pick A or B per Open Question 1 before starting.

- [ ] **3.3.1 (A)** Add an alias-and-normalize step in `KeyboardShortcutRecorder.svelte` before splitting: `ctrl→Control`, `cmd|command|⌘→Command`, `option|opt|⌥→Option`, `alt→Alt`, `shift|⇧→Shift`, `space→Space`, etc. Case-insensitive. Surface a validation error toast if any token does not normalize.
- [ ] **3.3.1 (B)** Replace the text input with modifier checkboxes (Cmd/Option/Ctrl/Shift) plus a key dropdown. No free-text path.

#### Wave 3.4: Surface registration errors

- [ ] **3.4.1** In `global-shortcut-manager.ts:125-133`, replace `if (registerError) return Ok(undefined);` with `if (registerError) return Err(registerError);`.
- [ ] **3.4.2** Verify the existing error-toast plumbing in `syncGlobalShortcutsWithSettings` (`register-commands.ts:113-137`) shows the cause; if message is opaque, include the raw plugin error.
- [ ] **3.4.3** Confirm with a deliberately-bad combo (e.g. `Cmd+Space` which macOS reserves) that the toast appears and the shortcut row reflects "not set".

#### Wave 3.5: Cleanup

- [ ] **3.5.1** Remove or hide the diagnostic logging from 3.1 once 3.2-3.4 are verified. If keeping, gate fully behind `import.meta.env.DEV`.

## Edge Cases

### Option+Space conflicts with another app's hotkey

1. User has Raycast or Spotlight (with custom binding) on Option+Space.
2. Tauri's `register("Alt+Space")` returns an error or registers but never fires.
3. With Phase 2.4 in place, the user sees a toast on app start: "Could not register Alt+Space (already in use)".
4. The settings page shows the combo as unregistered.

### Existing user has customized `toggleManualRecording`

1. User has `Cmd+Shift+;` working (US keyboard) or has set a custom combo.
2. Phase 3 migration logic: only reset if value equals the *literal old default*. Custom values left alone.

### User on FI ISO records a shortcut, then a US-layout user runs the same install

1. FI user records `Cmd+Shift+the-Ö-physical-key`. Stored as `Command+Shift+;`.
2. The install is portable (deviceConfig is per-machine, per the existing design at `device-config.svelte.ts:25`), so this is mostly a non-issue. But if config syncs (it does not today), the US user would see `Cmd+Shift+;` and physical Semicolon would trigger; same physical position; consistent.

### `e.code` is empty (older browsers, some Linux X11 quirks)

1. Recorder falls back to `e.key`-based detection if `e.code` is empty.
2. Surface a debug log; this should not happen in the bundled webview but worth defending against.

### Recording while another popover or dialog is open

1. Out of scope; the recorder is the only consumer of `createPressedKeys` now that local hotkeys are gone.

## Open Questions

1. **Cancel-recording default combo: ship one or not?**
   - Options: (a) ship nothing, user adds if they want; (b) `Alt+Shift+Space`; (c) `Alt+Esc`.
   - **Recommendation**: (a). User said "what else do you really need to get started — maybe none?". Ship one combo (toggle), let the user discover they want cancel and add it. Less is more.
2. **Manual entry: alias normalization (3.3.1 A) or structured editor (3.3.1 B)?**
   - (A) is ~30 lines, preserves muscle memory of typing combos, but always has edge cases (`win`? `super`? `⌘`?).
   - (B) is ~80 lines but eliminates the entire class of invalid-input bugs and is more accessible. Most modern apps (Raycast, Linear) use this.
   - **Recommendation**: (B). The manual-entry path is the bug origin and a structured editor closes it permanently. (A) is acceptable as a stopgap if (B) feels like scope creep.
3. **`pushToTalk` as a global hotkey: is the current architecture able to deliver press vs release events reliably across OSes?**
   - The existing `on: ShortcutEventState[]` plumbing distinguishes `'Pressed'` from `'Released'` for local shortcuts. Tauri's global-shortcut plugin emits a single event on activation; press/release semantics differ by OS.
   - **Recommendation**: Defer. PTT-as-global is its own design problem, not blocking the current bugs.
4. **Default-OFF for existing users with configured local hotkeys: silent flip, one-time toast, or grandfather them in?**
   - **Resolved**: Grandfather. Users with at least one local shortcut configured keep local=ON; everyone else (including fresh installs) defaults to OFF. See Wave 1.4 for the migration mechanism.

## Decisions Log

- Keep `DEFAULT_GLOBAL_SHORTCUTS` as a map rather than a single string constant: constraint is that the schema in `register-commands.ts` already iterates `commands` and looks up by command id; turning it into a single value would require a separate code path. Revisit when: the commands list is refactored to a tagged-union shape that includes its own default metadata.
- Keep `CommandOrAlt`/`CommandOrControl` aliases: constraint is that they are still referenced from a handful of comments/docs and from `query/desktop/shortcuts.ts:25-28`. Revisit when: those references are gone and only literal `Alt`/`Command`/`Control` strings remain in defaults.
- Keep `OPTION_KEY_CHARACTER_MAP` for now: constraint is that even with Phase 2.2 in place, users on the macOS Safari/WebView combo may still get layout-dependent characters in edge cases (Option held while typing). Revisit when: confirmed via the Phase 2.1 logs that `e.code` is reliably populated in the Tauri webview.
- Keep duplicated Switch-block markup in `local/+page.svelte` and `global/+page.svelte`: constraint is two instances do not justify a shared component yet; extraction would be premature abstraction. Revisit when: a third subsystem toggle is added anywhere in settings.
- Phase 1 invariant: `syncLocalShortcutsWithSettings` is a no-op while `shortcuts.local.enabled === false`. The window listener is gated on the same setting in `+layout.svelte`. Flipping the toggle back to true re-runs the sync (via reactive `$effect` in `AppLayout.svelte`) and re-mounts the listener.

## Success Criteria

- [ ] Two settings toggles exist and work: `shortcuts.local.enabled` (default OFF), `shortcuts.global.enabled` (default ON). Flipping either takes effect immediately.
- [ ] With local OFF, recording a global shortcut does not trigger any in-app action (bug #2 resolved by default).
- [ ] With local ON, local shortcuts work the same as today.
- [ ] FI keyboard user can record a global shortcut on a punctuation key (verified by user testing on their machine).
- [ ] Manual entry of `ctrl+shift+a` (or whatever the chosen normalization accepts) registers the intended combo. Manual entry of garbage produces a visible error.
- [ ] A deliberately-failing registration (e.g. `Cmd+Space` on macOS) produces a user-visible error toast instead of silent "saved".
- [ ] Fresh install: `Option+Space` toggles recording on macOS, `Alt+Space` toggles on Win/Linux. No other defaults.
- [ ] Existing users on customized combos are not disrupted.
- [ ] `bun run typecheck` and `bun run build` pass for `apps/whispering`.
- [ ] No new dependencies added.

## References

- `apps/whispering/src/routes/(app)/+layout.svelte:26-28` (kill site for local listener)
- `apps/whispering/src/lib/services/local-shortcut-manager.ts` (whole file, slated for deletion)
- `apps/whispering/src/lib/utils/createPressedKeys.svelte.ts:60-136` (capture pipeline)
- `apps/whispering/src/lib/services/desktop/global-shortcut-manager.ts` (accelerator builder; lines 117, 125-133, 208-248, 276-357)
- `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/KeyboardShortcutRecorder.svelte:194-202` (manual entry bug)
- `apps/whispering/src/routes/(app)/_layout-utils/register-commands.ts:15-40` (defaults)
- `apps/whispering/src/lib/constants/keyboard/macos-option-key-map.ts` (option-char map, OPTION_DEAD_KEYS dead code)
- `apps/whispering/src/lib/constants/platform/is-macos.ts` (platform constant)
- W3C `KeyboardEvent.code` reference: <https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_code_values>

## Review

(To be filled in after implementation.)
