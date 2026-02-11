---
name: control-flow
description: Human-readable control flow patterns for refactoring complex conditionals. Use when refactoring nested conditionals, improving code readability, or restructuring decision logic.
---

# Human-Readable Control Flow

When refactoring complex control flow, mirror natural human reasoning patterns:

1. **Ask the human question first**: "Can I use what I already have?" -> early return for happy path
2. **Assess the situation**: "What's my current state and what do I need to do?" -> clear, mutually exclusive conditions
3. **Take action**: "Get what I need" -> consolidated logic at the end
4. **Use natural language variables**: `isUsingNavigator`, `isUsingLocalTranscription`, `needsOldFileCleanup`: names that read like thoughts
5. **Avoid artificial constructs**: No nested conditions that don't match how humans actually think through problems

Transform this: nested conditionals with duplicated logic
Into this: linear flow that mirrors human decision-making

## Example: Early Returns with Natural Language Variables

```typescript
// From apps/whispering/src/routes/(app)/_layout-utils/check-ffmpeg.ts

export async function checkFfmpegRecordingMethodCompatibility() {
  if (!window.__TAURI_INTERNALS__) return;

  // Only check if FFmpeg recording method is selected
  if (settings.value['recording.method'] !== 'ffmpeg') return;

  const { data: ffmpegInstalled } = await rpc.ffmpeg.checkFfmpegInstalled.ensure();
  if (ffmpegInstalled) return; // FFmpeg is installed, all good

  // FFmpeg recording method selected but not installed
  toast.warning('FFmpeg Required for FFmpeg Recording Method', {
    // ... toast content
  });
}
```

## Example: Natural Language Booleans

```typescript
// From apps/whispering/src/routes/(app)/_layout-utils/check-ffmpeg.ts

const isUsingNavigator = settings.value['recording.method'] === 'navigator';
const isUsingLocalTranscription =
  settings.value['transcription.selectedTranscriptionService'] === 'whispercpp' ||
  settings.value['transcription.selectedTranscriptionService'] === 'parakeet';

return isUsingNavigator && isUsingLocalTranscription && !isFFmpegInstalled;
```

## Example: Cleanup Check with Comment

```typescript
// From packages/epicenter/src/indexes/markdown/markdown-index.ts

/**
 * This is checking if there's an old filename AND if it's different
 * from the new one. It's essentially checking: "has the filename
 * changed?" and "do we need to clean up the old file?"
 */
const needsOldFileCleanup = oldFilename && oldFilename !== filename;
if (needsOldFileCleanup) {
  const oldFilePath = path.join(tableConfig.directory, oldFilename);
  await deleteMarkdownFile({ filePath: oldFilePath });
  tracking[table.name]!.deleteByFilename({ filename: oldFilename });
}
```
