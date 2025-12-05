# Transform Clipboard Command

## Date
October 27, 2025

## Overview
Implement a keyboard command that allows users to run transformations on clipboard text (or selected text), mirroring the existing transformation workflow for recordings but working on arbitrary text input.

## Problem Statement
Currently, users can run transformations on recordings via the TransformationPicker in the recordings table (RecordingRowActions.svelte:116-152). However, there's no way to:
1. Run a transformation on arbitrary clipboard text
2. Trigger transformations via keyboard shortcut
3. Use transformations outside the recordings workflow

This limits the usefulness of transformations since users can't quickly transform text from other sources.

## User Stories

### Primary Use Case
**As a user**, I want to:
1. Copy text from any source (browser, notes app, etc.)
2. Press a keyboard shortcut
3. Select a transformation from a picker
4. Have the transformed text automatically copied back to my clipboard (and optionally written to cursor)

### Secondary Use Case (Future Enhancement)
**As a power user**, I might want to:
1. Set a "default" or "favorite" transformation
2. Press a shortcut to instantly apply that transformation to clipboard
3. Skip the picker dialog for frequently-used transformations

## Design Decisions

### Decision 1: One Command vs Two Commands?

**Option A: Single Command with Picker (RECOMMENDED)**
- Add one command: `transformClipboard`
- Always shows TransformationPicker
- Simple, discoverable UX
- Consistent with recordings workflow

**Option B: Two Commands**
- `transformClipboardWithPicker`: Shows picker
- `transformClipboardQuick`: Uses last-used or default transformation
- More power user friendly
- Requires additional state management (`settings['transformation.lastUsedId']` or `settings['transformation.defaultId']`)

**Recommendation**: Start with Option A. Add Option B later if users request it.

### Decision 2: UI Pattern

**Reuse TransformationPicker Component**
- Already exists at `apps/whispering/src/routes/(config)/recordings/row-actions/TransformationPicker.svelte`
- Takes `onSelect` callback
- Shows all transformations with search
- Has "Manage transformations" link

**Challenge**: TransformationPicker is designed to be triggered by a button click, but we need to trigger it from a keyboard command.

**Solution**: Create a reactive state that controls the picker's open state:
```typescript
let transformClipboardPickerOpen = $state(false);
```

Then the command just sets `transformClipboardPickerOpen = true`.

### Decision 3: Where to Place the Picker UI

**Option A: In AppShell.svelte**
- Global app shell component
- Already imports transformation logic
- Centralized command handling

**Option B: New Global Component**
- Create `TransformClipboardDialog.svelte`
- Import in AppShell
- More modular

**Recommendation**: Option A (AppShell.svelte) for simplicity, similar to how recordings are handled.

## Technical Implementation Plan

### Phase 1: Core Command (Minimum Viable Product)

#### 1. Add Command Definition
File: `apps/whispering/src/lib/commands.ts`

```typescript
{
  id: 'transformClipboard',
  title: 'Transform clipboard text',
  on: 'Pressed',
  callback: () => rpc.commands.transformClipboard.execute(undefined),
},
```

#### 2. Implement RPC Command Handler
File: `apps/whispering/src/lib/query/commands.ts`

```typescript
transformClipboard: defineMutation({
  mutationKey: ['commands', 'transformClipboard'],
  resultMutationFn: async (): Promise<WhisperingResult<void>> => {
    // 1. Read clipboard
    const { data: clipboardText, error: readError } =
      await rpc.text.readFromClipboard.execute();

    if (readError || !clipboardText?.trim()) {
      return WhisperingErr({
        title: 'Empty clipboard',
        description: 'Please copy some text before running a transformation.',
      });
    }

    // 2. Open transformation picker
    // This will be handled by reactive state in AppShell
    transformClipboardState.open(clipboardText);

    return Ok(undefined);
  },
}),
```

#### 3. Add Transformation Picker to AppShell
File: `apps/whispering/src/routes/+layout/AppShell.svelte`

```svelte
<script>
  // ... existing imports
  import TransformationPicker from '$lib/routes/(config)/recordings/row-actions/TransformationPicker.svelte';

  // State for transform clipboard workflow
  let transformClipboardText = $state<string | null>(null);
  let transformClipboardPickerOpen = $state(false);

  // Expose state to command handler
  window.__transformClipboardState = {
    open: (text: string) => {
      transformClipboardText = text;
      transformClipboardPickerOpen = true;
    }
  };
</script>

<!-- Existing app shell content -->

{#if transformClipboardText}
  <TransformationPicker
    bind:open={transformClipboardPickerOpen}
    onSelect={async (transformation) => {
      const toastId = nanoid();
      rpc.notify.loading.execute({
        id: toastId,
        title: '🔄 Running transformation...',
        description: 'Transforming your clipboard text...',
      });

      const { data: output, error } = await rpc.transformer.transformInput.execute({
        input: transformClipboardText,
        transformation,
      });

      if (error) {
        rpc.notify.error.execute(error);
        return;
      }

      rpc.sound.playSoundIfEnabled.execute('transformationComplete');

      rpc.delivery.deliverTransformationResult.execute({
        text: output,
        toastId,
      });

      transformClipboardText = null;
    }}
  />
{/if}
```

#### 4. Add Default Keyboard Shortcut
File: `apps/whispering/src/lib/settings/settings.ts`

```typescript
'shortcuts.transformClipboard': z
  .string()
  .default(`${CommandOrControl}+Shift+T`),
```

### Phase 2: Enhanced Features (Future)

#### 1. Last-Used Transformation Tracking
Store the last-used transformation ID:
```typescript
'transformation.lastUsedId': z.string().nullable().default(null),
```

Update `transformInput` mutation to track:
```typescript
settings.value = {
  ...settings.value,
  'transformation.lastUsedId': transformation.id
};
```

#### 2. Quick Transform Command
Add a second command that uses last-used:
```typescript
{
  id: 'transformClipboardQuick',
  title: 'Transform clipboard (use last transformation)',
  on: 'Pressed',
  callback: () => rpc.commands.transformClipboardQuick.execute(undefined),
},
```

#### 3. Default/Favorite Transformation
Add UI to mark a transformation as default:
- Add `isFavorite` or `isDefault` field to Transformation model
- Show star icon in transformation list
- Use default transformation for quick command if last-used doesn't exist

## Alternative Approaches Considered

### Alternative 1: Modal Dialog Instead of Picker
**Pros**: More explicit, easier to trigger from keyboard
**Cons**: Heavier UI, less consistent with existing patterns
**Decision**: Rejected - picker is lighter weight and consistent

### Alternative 2: Always Use Last-Used (No Picker)
**Pros**: Fastest workflow for power users
**Cons**: Not discoverable, confusing for first-time use
**Decision**: Rejected - picker-first is more user-friendly

### Alternative 3: Read Selected Text Instead of Clipboard
**Pros**: More precise, works with highlighted text
**Cons**: Platform-dependent, harder to implement reliably
**Decision**: Deferred - clipboard is simpler and works everywhere

## Files to Modify

### New Files
None (reuse existing components)

### Modified Files
1. `apps/whispering/src/lib/commands.ts` - Add command definition
2. `apps/whispering/src/lib/query/commands.ts` - Add RPC handler
3. `apps/whispering/src/routes/+layout/AppShell.svelte` - Add picker UI
4. `apps/whispering/src/lib/settings/settings.ts` - Add shortcut default

### Files to Read (for context)
1. `apps/whispering/src/lib/query/transformer.ts` - Understand transformInput mutation
2. `apps/whispering/src/lib/query/delivery.ts` - Understand delivery workflow
3. `apps/whispering/src/routes/(config)/recordings/row-actions/RecordingRowActions.svelte` - Reference implementation
4. `apps/whispering/src/routes/(config)/recordings/row-actions/TransformationPicker.svelte` - Component to reuse

## Open Questions

### 1. How to trigger picker from keyboard command?
**Answer**: Use reactive state in AppShell that the command sets via a global reference.

### 2. Should we validate clipboard content?
**Answer**: Yes - check for empty/whitespace-only text and show friendly error.

### 3. What if there are no transformations configured?
**Answer**: TransformationPicker already shows "No transformation found" - works as-is.

### 4. Should we support selected text reading?
**Answer**: Not in Phase 1. Clipboard is simpler and cross-platform.

## Testing Checklist

### Manual Testing
- [ ] Command appears in shortcuts settings
- [ ] Default shortcut works (Cmd+Shift+T / Ctrl+Shift+T)
- [ ] Picker opens with all transformations
- [ ] Selecting transformation runs it on clipboard text
- [ ] Transformed text is copied to clipboard (based on settings)
- [ ] Transformed text is written to cursor (based on settings)
- [ ] Success toast appears with transformed text
- [ ] Error handling works for empty clipboard
- [ ] Error handling works for transformation failures
- [ ] Sound plays on success (based on settings)
- [ ] Works with multi-step transformations
- [ ] Works with different transformation types (find/replace, prompt)

### Edge Cases
- [ ] Empty clipboard shows helpful error
- [ ] Whitespace-only clipboard shows helpful error
- [ ] Very large clipboard text (10k+ characters)
- [ ] Special characters (emoji, unicode)
- [ ] Multiline text
- [ ] No transformations configured
- [ ] Picker is already open (double-trigger)
- [ ] User cancels picker (no action taken)

## Dependencies

### Existing Infrastructure (Ready to Use)
- ✅ `rpc.transformer.transformInput` - Transform arbitrary text
- ✅ `rpc.delivery.deliverTransformationResult` - Deliver results
- ✅ `rpc.text.readFromClipboard` - Read clipboard (needs verification)
- ✅ `rpc.text.copyToClipboard` - Write clipboard
- ✅ `rpc.text.writeToCursor` - Write to cursor
- ✅ TransformationPicker component
- ✅ Settings for copy/write behavior

### Missing Infrastructure
- ❌ `rpc.text.readFromClipboard` - Need to verify this exists or create it
- ❌ Global state mechanism for triggering picker from command

## Success Criteria

### Phase 1 (MVP)
1. User can press keyboard shortcut to open transformation picker
2. User can select a transformation from the picker
3. Transformation runs on current clipboard content
4. Result is delivered according to user settings (copy/cursor/toast)
5. Error handling works gracefully

### Phase 2 (Enhanced)
1. Last-used transformation is tracked
2. Quick command uses last-used transformation
3. UI shows last-used indicator
4. Settings allow configuring default transformation

## Timeline Estimate

### Phase 1 (MVP)
- Implementation: 2-3 hours
- Testing: 1 hour
- **Total: 3-4 hours**

### Phase 2 (Enhanced)
- Implementation: 2-3 hours
- Testing: 1 hour
- **Total: 3-4 hours**

## Review Notes
This spec intentionally starts simple (Phase 1) and leaves room for enhancement (Phase 2). The MVP provides immediate value while keeping the implementation straightforward. Phase 2 can be added based on user feedback and usage patterns.

The key insight is reusing the existing TransformationPicker component and transformation infrastructure - we're just wiring up a new trigger mechanism (keyboard command → clipboard text instead of button click → recording text).
