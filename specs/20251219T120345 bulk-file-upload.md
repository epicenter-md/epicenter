# Bulk File Upload Support Plan

## Implementation Status: COMPLETED ✅

### Changes Made:
1. **Renamed mutation**: `uploadRecording` → `uploadRecordings` (plural)
2. **Parallel processing**: All files are processed simultaneously using `Promise.all`
3. **File validation**: Filters for audio/video files with notification for skipped files
4. **Current limit**: Set to 10 files (can be increased to 100+ or removed entirely)

---

# Bulk File Upload Support Plan

## Overview

This plan outlines how to add support for uploading multiple audio/video files at once in the Whispering app, extending the current single-file upload functionality.

## Current State

- Single file upload mode implemented with FileDropZone
- Files are processed one at a time through `uploadRecording` mutation
- Each file creates a recording and triggers transcription pipeline
- UI shows only the latest recording

## Proposed Changes

### 1. Update FileDropZone Configuration
- Change `maxFiles={1}` to allow multiple files (e.g., `maxFiles={10}` or remove limit)
- Update UI text to indicate multiple file support

### 2. Batch Processing Architecture

#### Option A: Sequential Processing (Simpler)
- Process files one by one in sequence
- Show progress indicator for current file and queue status
- Pros: Simple to implement, predictable resource usage
- Cons: Slower for many files

#### Option B: Parallel Processing (Faster)
- Process multiple files concurrently (with limit, e.g., 3 at a time)
- Pros: Faster overall processing
- Cons: Higher resource usage, complex error handling

### 3. UI/UX Improvements

#### Upload Progress Component
```svelte
<UploadProgress 
  files={uploadQueue}
  currentFile={currentlyProcessing}
  completed={completedFiles}
  failed={failedFiles}
/>
```

#### States to Display:
- Queued (waiting to process)
- Uploading (creating recording)
- Transcribing (in transcription pipeline)
- Completed (success)
- Failed (with error reason)

### 4. Query Layer Updates

#### New Mutations Needed:
1. `uploadMultipleRecordings` - Handles batch upload logic
2. `getUploadQueueStatus` - Returns current upload queue state

#### Update Commands:
```typescript
uploadMultipleRecordings: defineMutation({
  mutationKey: ['recordings', 'uploadMultiple'] as const,
  resultMutationFn: async ({ files }: { files: File[] }) => {
    const results = [];
    
    for (const file of files) {
      // Validate file
      if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
        results.push({ file, status: 'rejected', reason: 'Invalid file type' });
        continue;
      }
      
      // Process file
      try {
        const blob = new Blob([await file.arrayBuffer()], { type: file.type });
        await processRecordingPipeline({
          blob,
          toastId: nanoid(),
          completionTitle: `📁 ${file.name} uploaded`,
          completionDescription: 'Processing next file...',
        });
        results.push({ file, status: 'success' });
      } catch (error) {
        results.push({ file, status: 'failed', error });
      }
    }
    
    return Ok(results);
  },
}),
```

### 5. State Management

#### Upload Queue Store
```typescript
const uploadQueue = {
  files: [] as QueuedFile[],
  processing: false,
  currentIndex: 0,
  results: [] as UploadResult[],
};

type QueuedFile = {
  id: string;
  file: File;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress?: number;
  error?: string;
};
```

### 6. Error Handling

- Individual file failures shouldn't stop the entire batch
- Collect all errors and display summary at end
- Allow retry for failed files
- Clear error messages for each failure type

### 7. Performance Considerations

- Set reasonable file size limits (e.g., 100MB per file)
- Implement chunked processing for very large files
- Consider memory usage with multiple large files
- Add option to cancel ongoing batch upload

### 8. Implementation Steps

1. **Phase 1: Basic Multi-File Support**
   - Update FileDropZone to accept multiple files
   - Implement sequential processing
   - Basic progress indication

2. **Phase 2: Enhanced UI**
   - Create dedicated upload progress component
   - Show individual file status
   - Add queue management (remove, retry)

3. **Phase 3: Performance Optimization**
   - Implement parallel processing option
   - Add chunked upload for large files
   - Optimize memory usage

4. **Phase 4: Advanced Features**
   - Drag to reorder queue
   - Save upload queue to localStorage
   - Resume interrupted uploads

### 9. Testing Considerations

- Test with various file types and sizes
- Test error scenarios (network issues, invalid files)
- Test performance with many files (20+)
- Test memory usage with large files
- Test cancellation at various stages

### 10. Future Enhancements

- Folder upload support
- ZIP file extraction and processing
- Automatic file type detection
- Bulk actions on completed transcriptions
- Export all transcriptions as single document