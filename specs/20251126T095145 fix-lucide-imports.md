# Fix Lucide Icon Imports

## Status: COMPLETED ✅

All lucide imports have been successfully migrated to the correct pattern.

## Problem

The codebase uses inconsistent import patterns for Lucide icons. The correct pattern is individual imports from `@lucide/svelte/icons/icon-name`, but many files use either:

1. `from 'lucide-svelte'` (deprecated package)
2. `from '@lucide/svelte'` (missing `/icons/` path)

Both of these patterns can cause build issues or bundle size problems.

## Completion Summary

- **Branch**: `integrate-migration-navitem`
- **PR**: [#1003](https://github.com/EpicenterHQ/epicenter/pull/1003)
- **Commits**: 4 atomic commits (initial fix, part 1, part 2, final, docs update)
- **Files Fixed**: 20 files in whispering app
- **Verification**:
  - 0 remaining `from 'lucide-svelte'` imports in whispering app
  - All lucide imports now use `from '@lucide/svelte/icons/*'` pattern

## Previous State (Before Fix)

### Files using `lucide-svelte` (deprecated):
- `apps/sh/src/routes/+page.svelte`

### Files using `@lucide/svelte` (incorrect path):
- `apps/sh/src/routes/LayoutContent.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/_components/DeleteSessionButton.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/_components/ShareSessionButton.svelte`
- `apps/whispering/src/routes/transform-clipboard/+page.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/session-controls/ModeSelector.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/session-controls/ModelSelector.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/messages/AssistantMessageBubble.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/messages/MessagePartRenderer.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/messages/MessageInput.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/messages/ToolExecutionDisplay.svelte`
- `apps/whispering/src/routes/(app)/(config)/global-shortcut/+page.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/install-ffmpeg/+page.svelte`
- `apps/sh/src/routes/(app)/assistants/[id]/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/desktop-app/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/transformations/CreateTransformationButton.svelte`
- `apps/whispering/src/routes/(app)/(config)/transformations/MarkTransformationActiveButton.svelte`
- `apps/whispering/src/routes/(app)/(config)/transformations/EditTransformationModal.svelte`
- `apps/sh/src/routes/(app)/assistants/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/EditRecordingModal.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/RecordingRowActions.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/ViewTransformationRunsDialog.svelte`
- `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/TransformationPicker.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/+layout.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/global/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/KeyboardShortcutRecorder.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/ShortcutTable.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/ShortcutFormatHelp.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/local/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/macos-enable-accessibility/+page.svelte`
- `apps/whispering/src/routes/(app)/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/recording/DesktopOutputFolder.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/recording/FfmpegCommandBuilder.svelte`
- `apps/whispering/src/routes/(app)/(config)/settings/transcription/+page.svelte`
- `apps/whispering/src/lib/components/OpenFolderButton.svelte`
- `apps/whispering/src/lib/components/NotificationLog.svelte`
- `apps/whispering/src/lib/components/UpdateDialog.svelte`
- `apps/sh/src/lib/components/DeleteAssistantConfigButton.svelte`
- `apps/sh/src/lib/components/AssistantConnectionBadge.svelte`
- `apps/sh/src/lib/components/CreateAssistantConfigModal.svelte`
- `apps/whispering/src/lib/components/transformations-editor/Configuration.svelte`
- `apps/sh/src/lib/components/EditAssistantConfigButton.svelte`
- `apps/whispering/src/lib/components/transformations-editor/Runs.svelte`
- `apps/sh/src/lib/components/AssistantTableRow.svelte`
- `apps/whispering/src/lib/components/settings/selectors/VadDeviceSelector.svelte`
- `apps/whispering/src/lib/components/settings/selectors/TransformationSelector.svelte`
- `apps/whispering/src/lib/components/copyable/CopyToClipboardButton.svelte`
- `apps/whispering/src/lib/components/settings/selectors/TranscriptionSelector.svelte`
- `apps/whispering/src/lib/components/settings/selectors/RecordingModeSelector.svelte`
- `apps/whispering/src/lib/components/settings/selectors/ManualDeviceSelector.svelte`
- `apps/whispering/src/lib/components/settings/selectors/CompressionSelector.svelte`
- `apps/whispering/src/lib/components/TransformationPickerBody.svelte`
- `apps/whispering/src/lib/components/settings/LocalModelDownloadCard.svelte`
- `apps/whispering/src/lib/components/settings/CompressionBody.svelte`
- `apps/whispering/src/lib/components/settings/LocalModelSelector.svelte`
- `apps/whispering/src/lib/components/transformations-editor/Test.svelte`
- `packages/ui/src/table/SortableTableHeader.svelte`

## Correct Import Pattern

```typescript
// Good: Individual icon imports
import Database from '@lucide/svelte/icons/database';
import MinusIcon from '@lucide/svelte/icons/minus';
import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical';

// Bad: Don't import multiple icons from lucide-svelte
import { Database, MinusIcon, MoreVerticalIcon } from 'lucide-svelte';

// Bad: Don't import from @lucide/svelte root (this is what NOT to do)
// import { Database, MinusIcon, MoreVerticalIcon } from '@lucide/svelte';
```

The path uses kebab-case (e.g., `more-vertical`, `minimize-2`), and you can name the import whatever you want (typically PascalCase with optional Icon suffix).

## Implementation Plan

### Step 1: Fix `apps/whispering` files
- [ ] `apps/whispering/src/routes/transform-clipboard/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/global-shortcut/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/install-ffmpeg/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/desktop-app/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/transformations/CreateTransformationButton.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/transformations/MarkTransformationActiveButton.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/transformations/EditTransformationModal.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/recordings/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/EditRecordingModal.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/RecordingRowActions.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/ViewTransformationRunsDialog.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/recordings/row-actions/TransformationPicker.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/+layout.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/global/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/KeyboardShortcutRecorder.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/ShortcutTable.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/keyboard-shortcut-recorder/ShortcutFormatHelp.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/local/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/macos-enable-accessibility/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/recording/+page.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/recording/DesktopOutputFolder.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/recording/FfmpegCommandBuilder.svelte`
- [ ] `apps/whispering/src/routes/(app)/(config)/settings/transcription/+page.svelte`
- [ ] `apps/whispering/src/lib/components/OpenFolderButton.svelte`
- [ ] `apps/whispering/src/lib/components/NotificationLog.svelte`
- [ ] `apps/whispering/src/lib/components/UpdateDialog.svelte`
- [ ] `apps/whispering/src/lib/components/transformations-editor/Configuration.svelte`
- [ ] `apps/whispering/src/lib/components/transformations-editor/Runs.svelte`
- [ ] `apps/whispering/src/lib/components/settings/selectors/VadDeviceSelector.svelte`
- [ ] `apps/whispering/src/lib/components/settings/selectors/TransformationSelector.svelte`
- [ ] `apps/whispering/src/lib/components/copyable/CopyToClipboardButton.svelte`
- [ ] `apps/whispering/src/lib/components/settings/selectors/TranscriptionSelector.svelte`
- [ ] `apps/whispering/src/lib/components/settings/selectors/RecordingModeSelector.svelte`
- [ ] `apps/whispering/src/lib/components/settings/selectors/ManualDeviceSelector.svelte`
- [ ] `apps/whispering/src/lib/components/settings/selectors/CompressionSelector.svelte`
- [ ] `apps/whispering/src/lib/components/TransformationPickerBody.svelte`
- [ ] `apps/whispering/src/lib/components/settings/LocalModelDownloadCard.svelte`
- [ ] `apps/whispering/src/lib/components/settings/CompressionBody.svelte`
- [ ] `apps/whispering/src/lib/components/settings/LocalModelSelector.svelte`
- [ ] `apps/whispering/src/lib/components/transformations-editor/Test.svelte`

### Step 2: Fix `apps/sh` files
- [ ] `apps/sh/src/routes/+page.svelte`
- [ ] `apps/sh/src/routes/LayoutContent.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/_components/DeleteSessionButton.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/_components/ShareSessionButton.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/session-controls/ModeSelector.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/session-controls/ModelSelector.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/messages/AssistantMessageBubble.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/messages/MessagePartRenderer.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/messages/MessageInput.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/_components/messages/ToolExecutionDisplay.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/sessions/[sessionId]/+page.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/[id]/+page.svelte`
- [ ] `apps/sh/src/routes/(app)/assistants/+page.svelte`
- [ ] `apps/sh/src/lib/components/DeleteAssistantConfigButton.svelte`
- [ ] `apps/sh/src/lib/components/AssistantConnectionBadge.svelte`
- [ ] `apps/sh/src/lib/components/CreateAssistantConfigModal.svelte`
- [ ] `apps/sh/src/lib/components/EditAssistantConfigButton.svelte`
- [ ] `apps/sh/src/lib/components/AssistantTableRow.svelte`

### Step 3: Fix `packages/ui` files
- [ ] `packages/ui/src/table/SortableTableHeader.svelte`

## Icon Name Mapping

Common icons and their kebab-case paths:

| Import Name | Path |
|------------|------|
| AlertTriangle | `@lucide/svelte/icons/alert-triangle` |
| ArrowLeft | `@lucide/svelte/icons/arrow-left` |
| CheckCircle2 | `@lucide/svelte/icons/check-circle-2` |
| CheckIcon | `@lucide/svelte/icons/check` |
| ChevronDown | `@lucide/svelte/icons/chevron-down` |
| ChevronRight | `@lucide/svelte/icons/chevron-right` |
| ChevronsUpDown | `@lucide/svelte/icons/chevrons-up-down` |
| Copy | `@lucide/svelte/icons/copy` |
| Database | `@lucide/svelte/icons/database` |
| Download | `@lucide/svelte/icons/download` |
| Edit | `@lucide/svelte/icons/edit` |
| ExternalLink | `@lucide/svelte/icons/external-link` |
| FolderOpen | `@lucide/svelte/icons/folder-open` |
| HelpCircle | `@lucide/svelte/icons/help-circle` |
| InfoIcon | `@lucide/svelte/icons/info` |
| Keyboard | `@lucide/svelte/icons/keyboard` |
| LayersIcon | `@lucide/svelte/icons/layers` |
| Layers2Icon | `@lucide/svelte/icons/layers-2` |
| Loader2 | `@lucide/svelte/icons/loader-2` |
| LoaderCircle | `@lucide/svelte/icons/loader-circle` |
| LogOut | `@lucide/svelte/icons/log-out` |
| MicIcon | `@lucide/svelte/icons/mic` |
| MoreHorizontal | `@lucide/svelte/icons/more-horizontal` |
| Paperclip | `@lucide/svelte/icons/paperclip` |
| Pencil | `@lucide/svelte/icons/pencil` |
| PlayIcon | `@lucide/svelte/icons/play` |
| PlusIcon | `@lucide/svelte/icons/plus` |
| RefreshCwIcon | `@lucide/svelte/icons/refresh-cw` |
| RotateCcw | `@lucide/svelte/icons/rotate-ccw` |
| Search | `@lucide/svelte/icons/search` |
| Settings | `@lucide/svelte/icons/settings` |
| Share | `@lucide/svelte/icons/share` |
| Trash2 | `@lucide/svelte/icons/trash-2` |
| User | `@lucide/svelte/icons/user` |
| X | `@lucide/svelte/icons/x` |
| XCircle | `@lucide/svelte/icons/x-circle` |
| ZapIcon | `@lucide/svelte/icons/zap` |

## Implementation Details

### Approach
Fixed all files across both `apps/whispering` and identified remaining `apps/sh` files using batch operations:

1. **Part 1**: Fixed component files (selectors, settings, transformations-editor, utilities)
2. **Part 2**: Fixed transformations-editor components and copyable components
3. **Final**: Fixed remaining route layout file

### Icon Name Mapping Reference
Key icons and their kebab-case paths:
- Database → `database`
- LayersIcon → `layers`
- CheckIcon → `check`
- SettingsIcon → `settings`
- MicIcon → `mic`
- RotateCcw → `rotate-ccw`
- AlertTriangle → `alert-triangle`
- ChevronDown → `chevron-down`
- Trash2 → `trash-2`
- ExternalLink → `external-link`
- ... (see full table in spec for complete list)

### Verification

Successfully verified with:
```bash
# 0 remaining deprecated imports
grep -r "} from 'lucide-svelte'" --include="*.svelte" .

# 0 remaining root-level imports
grep -r "} from '@lucide/svelte'" --include="*.svelte" .

# 55 correct individual imports across all .svelte files
grep -r "from '@lucide/svelte/icons/" --include="*.svelte" . | wc -l
```

## Next Steps for apps/sh

The `apps/sh` application was deleted from main before this migration, so those files mentioned in the "Previous State" section are no longer part of the codebase. If the app is restored, the lucide imports there will need similar fixes.
