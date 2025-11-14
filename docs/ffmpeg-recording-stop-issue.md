# FFmpeg Recording Stop Issue - Investigation Handoff

## Problem Statement

Windows users are experiencing failures when stopping FFmpeg recordings. The error indicates the output file doesn't exist when we attempt to read it after stopping the recording.

### Error Message
```json
{
  "message": "Unable to read recording file",
  "cause": {
    "message": "Failed to read file as Blob: C:\\Users\\braden\\AppData\\Roaming\\com.bradenwong.whispering\\recordings\\ktYnf6QtjD7MPG8hI7YqI.wav",
    "cause": "failed to open file at path: C:\\Users\\braden\\AppData\\Roaming\\com.bradenwong.whispering\\recordings\\ktYnf6QtjD7YqI.wav with error: The system cannot find the file specified. (os error 2)",
    "name": "FsServiceError"
  },
  "name": "RecorderServiceError"
}
```

### User-Reported Behavior
- Stopping process takes ~3 seconds
- UI shows: "Stopping" → "Loading" → "Stopping" → "Failed"
- No intermediate error messages
- The recording output file is never created/finalized

## Current Architecture

### State Management
The FFmpeg recorder maintains two pieces of in-memory state:
- `activeChild: Child | null` - The spawned FFmpeg process
- `activeOutputPath: string | null` - Path where recording should be written

### Recording Start Flow
1. Generate output path in AppData recordings directory
2. Build FFmpeg command with platform-specific device formatting
3. Spawn FFmpeg process via Tauri plugin-shell
4. Store `activeChild` and `activeOutputPath`
5. Return immediately (non-blocking)

### Recording Stop Flow (Current Implementation)
Located in `apps/whispering/src/lib/services/recorder/ffmpeg.ts`, `stopRecording` method:

1. **Graceful shutdown attempts:**
   - Send stdin 'q\n' to FFmpeg process (wait 1 second)
   - Send SIGINT via Tauri command
   - Schedule force kill after 5 seconds (fire-and-forget)

2. **Clear state:**
   - Set `activeChild = null`
   - Set `activeOutputPath = null`

3. **File polling loop (max 6 seconds):**
   - Check if file exists every 100ms
   - Verify file size is stable across 2 checks
   - If stable, read file as Blob and return
   - If timeout, return error

### Platform-Specific Details

**Windows (DirectShow):**
- Device format: `audio="Device Name"`
- FFmpeg input: `-f dshow -i audio="Device Name"`
- SIGINT sent via custom Tauri command (simulates Ctrl+C)

**macOS (AVFoundation):**
- Device format: `:deviceId`
- FFmpeg input: `-f avfoundation -i ":deviceId"`

**Linux (ALSA/PulseAudio):**
- Device format: `deviceId`
- FFmpeg input: `-f alsa -i deviceId` or `-f pulse -i deviceId`

## Code References

### Key Functions

**`startRecording` (line ~274-371):**
```typescript
const process = await Command.create('ffmpeg', args, options).spawn();
activeChild = process;
activeOutputPath = outputPath;
```

**`stopRecording` (line ~342-444):**
```typescript
// Try stdin 'q' (1s wait)
await activeChild.write('q\n');
await new Promise(resolve => setTimeout(resolve, 1000));

// Send SIGINT
await sendSigint(activeChild.pid);

// Schedule force kill (5s)
scheduleBackupKill(5000);

// Clear state
activeChild = null;
activeOutputPath = null;

// Poll for file (max 6s)
while (Date.now() - startTime < MAX_WAIT_TIME) {
  // Check file exists and size is stable
}
```

**`scheduleBackupKill` (line ~357-364):**
```typescript
const scheduleBackupKill = (delayMs: number) => {
  setTimeout(() => {
    activeChild?.kill().catch(() => {});
  }, delayMs);
};
```

### Tauri Commands

**`send_sigint` (src-tauri/src/commands/process.rs):**
- Windows: Uses `windows::Win32::System::Console::GenerateConsoleCtrlEvent`
- Unix: Sends SIGINT via `nix::sys::signal::kill`

## Timeline of Recent Changes

1. **Initial issue:** Device enumeration failed (regex didn't match FFmpeg output)
2. **Fix:** Updated regex to match `[dshow @ ...]` prefix
3. **Issue:** Stopping failed with "file not found"
4. **Attempted fix:** Added stdin 'q' for Windows
5. **Refactor:** Removed session persistence, kept only in-memory state
6. **Refactor:** Simplified branching logic in stopRecording
7. **Attempted simplification:** Removed stdin 'q', relied on SIGINT only
8. **Current state:** Restored stdin 'q' + SIGINT, increased timeouts to 5s/6s

## Investigation Questions

1. **Is FFmpeg actually receiving the shutdown signals?**
   - Is stdin 'q' being processed?
   - Is SIGINT reaching the FFmpeg process?
   - Is the force kill executing too early?

2. **Is FFmpeg creating the file at all?**
   - Does the file exist temporarily and then get deleted?
   - Is FFmpeg failing to start writing?
   - Are there FFmpeg error logs we're not capturing?

3. **Is the file path correct?**
   - Is AppData path accessible/writable?
   - Are there path escaping issues on Windows?
   - Is FFmpeg writing to a different location?

4. **Is the process lifecycle correct?**
   - Should we wait for process exit before clearing state?
   - Does clearing `activeChild = null` affect the scheduled force kill?
   - Is there a race condition with the backup kill?

5. **Are the timeouts appropriate?**
   - Does FFmpeg need more time to finalize on Windows?
   - Is 1 second enough after stdin 'q'?
   - Should we wait for process exit confirmation?

## Files to Examine

- `apps/whispering/src/lib/services/recorder/ffmpeg.ts` - Main recorder service
- `apps/whispering/src-tauri/src/commands/process.rs` - SIGINT implementation
- `apps/whispering/src/lib/services/fs/fs.ts` - File reading logic

## Next Steps

The previous attempts focused on adjusting shutdown mechanisms and timeouts. A fresh investigation should:

1. Verify FFmpeg is actually writing files (check if temporary files exist)
2. Confirm shutdown signals are reaching FFmpeg
3. Determine if the issue is process termination or file I/O
4. Consider whether state clearing should happen before or after file polling
5. Evaluate if we need to wait for process exit confirmation
