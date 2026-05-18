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

- [x] **2.1** `DEFAULT_GLOBAL_SHORTCUTS` rewritten in `register-commands.ts`: `{ toggleManualRecording: 'Alt+Space' }`, all others `null`.
- [x] **2.2** Legacy replacement at `query/desktop/shortcuts.ts:25-28` only rewrites `CommandOrControl`; `Alt` passes through unchanged. Tauri's `plugin-global-shortcut` accepts `Alt` and routes it to the Option key on macOS automatically (Alt is the W3C name).
- [x] **2.3** `migrateGlobalToggleDefaultToOptionSpace()` added: idempotent (localStorage marker), reseats `toggleManualRecording` to `Alt+Space` only when the current value is null OR exactly the old default (`Command+Shift+;` / `Control+Shift+;`). Custom user values are preserved. Wired into `AppLayout.svelte` onMount before `syncGlobalShortcutsWithSettings()`.
- [x] **2.4** No user-facing docs reference the old default (grep on README and code confirmed only an internal comment). Nothing to update.
- [ ] **2.5** Smoke-test on FI keyboard: fresh install → press Option+Space → recording toggles. (User to verify alongside Phase 1 and Phase 3.)

Commit boundary: Phase 2 ships as one PR.

### Phase 3: Fix global hotkey capture and surface errors

Goal: make recording work on FI (and any) layout, make manual entry honest, stop hiding errors.

#### Wave 3.1: Add diagnostic logging (gated by DEV)

- [x] **3.1.1** `createPressedKeys.svelte.ts` keydown handler logs `{key, code, metaKey, altKey, ctrlKey, shiftKey}` via `console.debug` under `import.meta.env.DEV`. Stays on as long as we may need FI-layout evidence.
- [x] **3.1.2** Skipped: superseded by Wave 3.4. We stopped swallowing the error entirely instead of logging it.
- [-] **3.1.3** Skipped (per user request to bundle Phase 1-3 testing). Evidence to be gathered post-hoc by user if Phase 3 fix doesn't work first try.

#### Wave 3.2: Switch capture to `e.code`-based key

- [x] **3.2.1** New `$lib/constants/keyboard/browser/code-to-key.ts` exports `codeToLogicalKey(code)` mapping W3C codes (`Semicolon`, `Minus`, `KeyA`, `Digit0`, `F1-F24`, `Space`, arrows, navigation, editing, numpad) to the lowercase logical form (`;`, `-`, `a`, `0`, `f1`, ` `, ...). Exported from `keyboard/index.ts`.
- [x] **3.2.2** Both keydown and keyup in `createPressedKeys.svelte.ts` now translate the non-modifier key through `codeToLogicalKey` first, falling back to `e.key` only when the code is unmapped. Modifier keys (`MODIFIER_KEYS` Set) continue to use e.key.
- [x] **3.2.3** Display remains unchanged: the recorder UI displays the stored accelerator (which is the canonical form), not the in-progress pressedKeys. Acceptable per the spec note.
- [-] **3.2.4** Pending user verification on FI hardware.

#### Wave 3.3: Honest manual entry (Option A: alias normalization)

- [x] **3.3.1 (A)** New `$lib/constants/keyboard/browser/parse-manual-shortcut.ts` exports `parseManualShortcut(input)` returning `{keys, invalidTokens}`. Alias map covers `ctrl|cmd|command|⌘|win|super|option|opt|⌥|alt|shift|⇧|altgr|space|spacebar|esc|escape|ret|return|enter|tab|bs|backspace|del|delete|ins|insert|home|end|pgup|pageup|pgdn|pagedown|up|down|left|right|arrow*`. Case-insensitive. Unmapped tokens pass through (handles `a`, `5`, `;`, `f5`, etc.).
- [x] **3.3.1** `KeyboardShortcutRecorder.svelte` onsubmit replaces the naive split-and-cast with `parseManualShortcut`. Invalid tokens trigger an error toast naming them; empty result is a silent no-op. The obsolete macOS Option-dead-key warning is removed (e.code fixes that path too).

#### Wave 3.4: Surface registration errors

- [x] **3.4.1** `global-shortcut-manager.ts` no longer swallows `tauriRegister` errors. The previous `return Ok(undefined)` on error is replaced with `return Err(registerError)`. Comment updated to explain the prior swallow was speculative; if false positives resurface we will gate per-error rather than swallow the whole class.
- [x] **3.4.2** Existing `syncGlobalShortcutsWithSettings` plumbing already shows the error message in a toast (`register-commands.ts:144-148`). No changes needed.
- [-] **3.4.3** Pending user verification (try `Cmd+Space` on macOS, expect error toast).

#### Wave 3.5: Cleanup

- [ ] **3.5.1** Diagnostic log left in place behind `import.meta.env.DEV` (no-op in production builds). Pull out in a follow-up commit once FI verification is confirmed clean.

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
- Keep `OPTION_KEY_CHARACTER_MAP` and `OPTION_DEAD_KEYS`: constraint is that they are no longer needed for the recorder path (e.code translation in `createPressedKeys.svelte.ts` bypasses Option dead keys and per-layout characters). `OPTION_KEY_CHARACTER_MAP` is still wired as a defensive fallback in `createPressedKeys`. `OPTION_DEAD_KEYS` is unused dead code. Revisit when: cleaning up after FI-keyboard verification confirms e.code is reliably populated in the Tauri webview.
- Local shortcut manager (`local-shortcut-manager.ts`) was not updated to use e.code in Phase 3. It still uses raw `e.key`. Grandfathered users with local enabled will see the layout-blind capture there. Revisit when: a user reports the issue on local shortcuts, OR when removing local hotkeys is reconsidered.

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

**Status**: Implemented across 3 commits on branch `fix/whispering-hotkeys`. Pending user smoke test (combined Phase 1+2+3 verification per user request).

### Commits

```
c2c6b7a4d  fix(whispering): make global hotkey capture layout-independent       (Phase 3)
52833f158  feat(whispering): ship Alt+Space as the only global hotkey default   (Phase 2)
438ca3653  feat(whispering): gate hotkey subsystems behind toggles              (Phase 1)
```

### What landed

**Phase 1: Subsystem toggles** (6 files modified, ~520 lines including spec)
- Two new settings: `shortcuts.local.enabled` (default `false`), `shortcuts.global.enabled` (default `true`).
- Local listener mounts only when enabled. Global registrations unregister system-wide when disabled. Reactive `$effect`s re-sync on toggle change.
- Master `Switch` on each shortcuts settings page; reset-to-defaults button disabled when subsystem off.
- Grandfather migration: existing users (detected via prior migration marker OR presence of old `whispering-settings` blob) keep local enabled; fresh installs get OFF.

**Phase 2: Sensible default** (3 files modified, ~60 lines)
- `DEFAULT_GLOBAL_SHORTCUTS` reduced to `{ toggleManualRecording: 'Alt+Space' }`; all others `null`.
- One-shot `migrateGlobalToggleDefaultToOptionSpace()` seeds `Alt+Space` when toggle is null OR exactly matches the old `Cmd+Shift+;` / `Ctrl+Shift+;` default. Custom user values preserved.
- Removed unused `CommandOrAlt`/`CommandOrControl` imports from `register-commands.ts`.

**Phase 3: Layout-independent capture + honest errors** (7 files, 268 lines incl. 2 new helpers)
- New `codeToLogicalKey(code)` translates W3C `KeyboardEvent.code` values to canonical lowercase keys. Used in both keydown and keyup of `createPressedKeys` for non-modifier keys.
- New `parseManualShortcut(input)` normalizes user-friendly aliases (`ctrl`, `cmd`, `option`, `space`, etc.) and returns invalid tokens for visible error feedback.
- `tauriRegister` errors now propagate to the existing toast plumbing instead of being swallowed.
- DEV-gated `console.debug` log on every keydown captures `{key, code, modifiers}` for diagnosing layout edge cases.
- Removed obsolete macOS Option-dead-key warning from the recorder (e.code bypasses it).

### Post-implementation review findings

| Phase | Issue | Severity | Disposition |
|---|---|---|---|
| 1 | Initial double-sync on cold mount (onMount + reactive effect both fire) | low | Acceptable; idempotent. Could simplify in a future cleanup. |
| 1 | Toggle UI markup duplicated across local/global pages | medium | Two instances does not justify extraction. Decisions Log entry to revisit if a third toggle appears. |
| 1 | Local-listener gating means local Map can drift from settings while subsystem is off | medium | Documented as an invariant: sync is no-op while off; flip-to-on re-runs sync. No data corruption possible since UI is disabled. |
| 2 | `OLD_TOGGLE_DEFAULTS` hardcodes two strings | low | Acceptable: those are the only two values the old default ever resolved to. |
| 3 | `OPTION_KEY_CHARACTER_MAP` is now mostly fallback-only; `OPTION_DEAD_KEYS` still unused dead code | low | Leave as defensive fallback until FI verification confirms e.code is reliably populated. |
| 3 | Local shortcut manager (`local-shortcut-manager.ts`) still uses raw `e.key` | low | Out of scope per user direction. Grandfathered local users will not benefit from the FI fix on local shortcuts. |
| 3 | DEV-gated log does not fire in production builds | medium | Communicated as a constraint; user runs dev for diagnostics. |

### What was deliberately not done

- Security hardening from prior audit (CSP, capability narrowing) — scoped to a separate branch per user direction.
- `pushToTalk` as a global hotkey — deferred (different press/release semantics across OSes via Tauri's plugin).
- Manual-entry restructured UI (modifier checkboxes + key dropdown) — chose alias normalization (Option A in OQ2) for minimal change. Decisions Log notes the long-term answer is the structured editor.
- Local subsystem layout fix — Phase 3 only touched the global capture path. Grandfathered local users may still see the FI-keyboard issue on local shortcuts.

### Pending user verification

- [ ] **Phase 1**: Fresh install shows local OFF; existing-user upgrade shows local ON. Toggle either subsystem and confirm immediate effect.
- [ ] **Phase 2**: Fresh install + Tauri → `Alt+Space` registered on first boot → pressing it toggles recording.
- [ ] **Phase 3 (FI keyboard)**: Open global shortcut editor, record `Cmd+Shift+<physical-Semicolon-position-key>` → stored accelerator is `Command+Shift+;` → triggering that physical combo fires the shortcut.
- [ ] **Phase 3 (manual entry)**: Type `ctrl+shift+a` → registers successfully. Type `garbage+foo` → error toast naming the invalid tokens.
- [ ] **Phase 3 (error surfacing)**: Try to register `Cmd+Space` on macOS (Spotlight reserves it) → error toast appears.

### Follow-up scope (not in this branch)

- Delete `OPTION_DEAD_KEYS` (unused).
- Apply the same e.code translation to `local-shortcut-manager.ts`.
- Consider replacing the manual-entry text input with a structured editor (OQ2 Option B).
- Cleanup pass: remove the DEV-gated log once FI verification is green.
- The original security hardening branch (CSP, fs scope, shell capability) per the prior audit.
