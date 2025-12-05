# Three Ways to Download Large Files in Tauri Without Freezing Your App

I was implementing a model downloader for Whispering when I hit a nasty problem: downloading anything over 100MB would make the entire app freeze, stutter, and eventually crash. The progress bar would jump erratically, the UI would become unresponsive, and users would think the app had died.

Here's what I learned about streaming large files in Tauri, and why the simplest solution turned out to be the best.

## The Problem: Memory Accumulation

My original implementation looked perfectly reasonable:

```typescript
const downloadFileContent = async (
    url: string,
    sizeBytes: number,
    onProgress: (progress: number) => void,
): Promise<Uint8Array> => {
    const response = await fetch(url);
    const reader = response.body?.getReader();

    const chunks: Uint8Array[] = [];  // 🚨 Problem starts here
    let downloadedBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);  // 🚨 Accumulating in memory
        downloadedBytes += value.length;
        onProgress(Math.round((downloadedBytes / sizeBytes) * 100));
    }

    // 🚨 Now we combine everything into one massive array
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const fileContent = new Uint8Array(totalLength);
    let position = 0;
    for (const chunk of chunks) {
        fileContent.set(chunk, position);
        position += chunk.length;
    }

    return fileContent;
};

// Then write the entire file at once
const fileContent = await downloadFileContent(url, size, onProgress);
await writeFile(path, fileContent);
```

This approach has several problems:

1. **Double memory usage**: We store chunks in an array, then create another massive Uint8Array
2. **JavaScript array overhead**: Each chunk in the array has object wrapper overhead
3. **Garbage collection pressure**: As the array grows, GC runs more frequently, causing stutters
4. **Browser memory limits**: Chrome tabs have memory limits; exceed them and things get ugly

For a 500MB file, this could easily consume 1GB+ of memory, causing the entire Electron/Tauri renderer process to struggle.

## Solution 1: Direct Streaming with Append

The first breakthrough came from discovering that Tauri's filesystem API supports append mode:

```typescript
const downloadFileContent = async (
    url: string,
    sizeBytes: number,
    filePath: string,
    onProgress: (progress: number) => void,
): Promise<void> => {
    const response = await fetch(url);
    const reader = response.body?.getReader();

    // Create or truncate the file first
    await writeFile(filePath, new Uint8Array());

    let downloadedBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Write each chunk directly to disk
        await writeFile(filePath, value, { append: true });

        downloadedBytes += value.length;
        onProgress(Math.round((downloadedBytes / sizeBytes) * 100));
    }
};

// Usage is cleaner too
await downloadFileContent(url, size, path, onProgress);
```

This immediately solved the memory problem. Instead of accumulating chunks, we stream them directly to disk. Memory usage stays constant at the size of a single chunk (usually 16-64KB).

### Pros:
- **Constant memory usage**: Only one chunk in memory at a time
- **No GC pressure**: Chunks are immediately released after writing
- **Handles any file size**: Could download terabytes without issues
- **Simple implementation**: Fewer moving parts, less to go wrong

### Cons:
- **More I/O operations**: Each chunk triggers a filesystem write
- **Potential performance overhead**: Many small writes vs. fewer large writes
- **Platform differences**: Append performance varies by OS

## Solution 2: Batched Streaming

To optimize I/O operations, I experimented with batching chunks before writing:

```typescript
const downloadFileContent = async (
    url: string,
    sizeBytes: number,
    filePath: string,
    onProgress: (progress: number) => void,
): Promise<void> => {
    const response = await fetch(url);
    const reader = response.body?.getReader();

    await writeFile(filePath, new Uint8Array());

    let downloadedBytes = 0;
    const BATCH_SIZE = 1024 * 1024; // 1MB batches
    let batchBuffer: Uint8Array[] = [];
    let batchSize = 0;

    const flushBatch = async () => {
        if (batchBuffer.length === 0) return;

        // Combine batch chunks into single write
        const combined = new Uint8Array(batchSize);
        let offset = 0;
        for (const chunk of batchBuffer) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        await writeFile(filePath, combined, { append: true });

        batchBuffer = [];
        batchSize = 0;
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            await flushBatch(); // Don't forget remaining data!
            break;
        }

        batchBuffer.push(value);
        batchSize += value.length;
        downloadedBytes += value.length;

        if (batchSize >= BATCH_SIZE) {
            await flushBatch();
        }

        onProgress(Math.round((downloadedBytes / sizeBytes) * 100));
    }
};
```

This approach buffers up to 1MB of chunks before writing, reducing I/O operations by ~20-60x depending on chunk size.

### Pros:
- **Fewer I/O operations**: Reduces system calls significantly
- **Better SSD performance**: SSDs prefer larger writes
- **Still memory-bounded**: Maximum 1MB in memory
- **Configurable batch size**: Can tune for specific needs

### Cons:
- **More complex**: Additional state management and edge cases
- **Delayed writes**: Data isn't on disk immediately
- **Potential data loss**: Crash before flush loses buffered data
- **Memory overhead**: Still accumulating some chunks (though limited)

## Performance Comparison

Here's what I observed downloading a 250MB model file:

| Approach | Memory Usage | I/O Operations | Time | UI Responsiveness |
|----------|--------------|----------------|------|-------------------|
| Memory Accumulation | ~500MB peak | 1 | 45s | Freezes constantly |
| Direct Streaming | ~64KB constant | ~4,000 | 38s | Perfectly smooth |
| Batched Streaming | ~1MB constant | ~250 | 36s | Perfectly smooth |

The time differences were minimal, but the user experience difference was massive.

## Why I Chose Direct Streaming

After testing all three approaches, I went with direct streaming (Solution 1). Here's why:

1. **Simplicity wins**: Fewer lines of code, fewer edge cases, easier to debug
2. **Good enough performance**: 2 seconds difference on a 250MB file? Users won't notice
3. **Modern filesystems are smart**: They already do write caching and batching
4. **Tauri's append is efficient**: It's not reopening the file each time
5. **Progress stays smooth**: Each chunk immediately updates progress, no batching delays

The key insight: I was optimizing the wrong thing. I focused on minimizing I/O operations when the real problem was memory usage. Once memory was constant, the I/O "problem" didn't actually impact user experience.

## Lessons Learned

1. **Profile before optimizing**: My assumptions about I/O being slow were wrong
2. **Memory pressure is worse than I/O**: GC pauses are more noticeable than filesystem writes
3. **Streaming APIs exist for a reason**: Don't accumulate what you can stream
4. **Simple solutions are maintainable solutions**: That clever batching logic? Future me won't thank current me

The next time you're downloading large files in a Tauri (or Electron) app, remember: that progress bar freezing isn't because downloads are slow—it's because your app is drowning in memory. Stream to disk, keep it simple, and let the filesystem do what it does best.

## Code Reference

The implementation lives in [`LocalModelDownloadCard.svelte:140-177`](/Users/braden/Code/whispering/apps/whispering/src/lib/components/settings/LocalModelDownloadCard.svelte) if you want to see it in action.