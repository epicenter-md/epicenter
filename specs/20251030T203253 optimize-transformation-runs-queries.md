# Optimize Transformation Runs Queries

**Created:** 2025-10-30T20:32:53
**Status:** Planning

## Problem

The `getByRecordingId` query in file-system.ts is taking 12-15 seconds per call because:
- We have 4,689 transformation run files
- Each query reads ALL files from disk using TypeScript/Tauri FFI
- The `join()` path operation goes through async Tauri FFI (4.5s per file cumulatively)
- The `readTextFile()` operation goes through async Tauri FFI (2.5-9s per file cumulatively)
- We're running 4,689 parallel async operations, causing filesystem thrashing
- This happens on every page load for each visible recording (5x parallel queries = 60+ seconds total)

## Solution

Two-phase optimization:

### Phase 1: Move file reading to Rust
Create a new Tauri command that reads all markdown files from a directory in one batch operation on the Rust side. This eliminates:
- 4,689 async FFI calls for `join()`
- 4,689 async FFI calls for `readTextFile()`
- Filesystem contention from parallel operations

**New Rust Command:**
```rust
#[tauri::command]
async fn read_markdown_files(directory_path: String) -> Result<Vec<String>, String>
```

This command will:
1. Read directory entries synchronously in Rust
2. Filter for .md files
3. Read all file contents in Rust
4. Return array of markdown content strings

**Benefits:**
- Single FFI call instead of 9,378 calls
- Native Rust filesystem operations (much faster)
- No async overhead for each file
- Sequential or batched reading (no thrashing)

### Phase 2: Add in-memory caching
After making reads fast, add caching layer:
1. Load all runs once on startup
2. Build indexes by recordingId and transformationId
3. Invalidate cache on mutations (create, update, delete)
4. Queries become instant lookups

## Implementation Plan

### Step 1: Create Rust command
- [ ] Add new file: `apps/whispering/src-tauri/src/commands/fs.rs`
- [ ] Implement `read_markdown_files` function
- [ ] Export command in `src-tauri/src/main.rs`

### Step 2: Update TypeScript
- [ ] Update `getByRecordingId` to use new Rust command
- [ ] Update `getByTransformationId` to use new Rust command
- [ ] Remove all performance logging

### Step 3: Add caching
- [ ] Create cache structure at module level
- [ ] Load cache on first query
- [ ] Invalidate on mutations
- [ ] Update all query methods to use cache

### Step 4: Test
- [ ] Test with 4,689 files
- [ ] Verify query time drops from 12-15s to < 100ms (Phase 1) to < 1ms (Phase 2)
- [ ] Test cache invalidation works correctly

## Expected Performance

**Before:**
- Query time: 12-15 seconds per recording
- 5 recordings = 60-75 seconds total

**After Phase 1:**
- Query time: < 100ms per recording (100-150x speedup)
- 5 recordings = < 500ms total

**After Phase 2:**
- Query time: < 1ms per recording (12,000-15,000x speedup)
- 5 recordings = < 5ms total

## Review

(To be filled after implementation)
