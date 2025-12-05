# Single FFI Call for Bulk File Operations

In Epicenter, I use a single `invoke` call to read or delete hundreds of files. This matters because before this pattern, I was using Tauri's built-in helper functions (`readTextFile`, `exists`, `remove`) in a loop. Even with `Promise.all`, you're sending thousands of individual FFI calls across the Tauri boundary.

## The Problem

A recordings folder can have thousands of markdown files. The naive approach reads them one by one:

```typescript
// BAD: Thousands of FFI calls
const files = await readDir(recordingsPath);
const contents = await Promise.all(
  files.map(async (file) => {
    const path = await join(recordingsPath, file.name);  // FFI call
    const content = await readTextFile(path);             // FFI call
    return content;
  })
);
```

For 500 files, that's 1,000 FFI calls minimum. Each `invoke` crosses the JavaScript-to-Rust boundary, which has overhead. `Promise.all` makes them concurrent, but you're still paying the FFI tax on every single file.

## The Solution: Batch in Rust

Move the loop to Rust. Pass the directory path once, let Rust handle all the file I/O natively, return the results in one shot:

```typescript
// GOOD: Single FFI call
const contents = await invoke<string[]>('read_markdown_files', {
  directoryPath: recordingsPath
});
```

The Rust side does the heavy lifting:

```rust
#[tauri::command]
pub async fn read_markdown_files(directory_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory_path);

        // Collect all .md file paths
        let paths: Vec<PathBuf> = fs::read_dir(&dir_path)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().extension() == Some("md".as_ref()))
            .map(|entry| entry.path())
            .collect();

        // Read all files in parallel using Rayon
        let contents: Vec<String> = paths
            .par_iter()
            .filter_map(|path| fs::read_to_string(path).ok())
            .collect();

        Ok(contents)
    }).await
}
```

Key details:
- `spawn_blocking` keeps file I/O off the Tokio async runtime
- `par_iter()` from Rayon parallelizes reads across CPU cores
- One FFI call, regardless of file count

## The Same Pattern for Deletes

Bulk deletion follows the same principle. Instead of:

```typescript
// BAD: O(n) FFI calls
for (const file of filesToDelete) {
  const path = await join(dir, file);  // FFI
  await remove(path);                   // FFI
}
```

Pass all paths to Rust at once:

```typescript
// GOOD: Single FFI call
await invoke('bulk_delete_files', { paths: pathsToDelete });
```

```rust
#[tauri::command]
pub async fn bulk_delete_files(paths: Vec<String>) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let deleted: u32 = paths
            .par_iter()
            .filter_map(|path| fs::remove_file(path).ok().map(|_| 1u32))
            .sum();
        Ok(deleted)
    }).await
}
```

## When to Use This Pattern

Use single-FFI-call batching when:
- Operating on many files (10+)
- The operation is uniform (same action on each file)
- You don't need per-file error handling in JavaScript

Keep individual calls when:
- Operating on 1-3 files
- You need fine-grained error handling per file
- The operation is complex or conditional

## Performance

For 500 markdown files on my machine:
- Individual FFI calls: ~2-3 seconds
- Single batched call with Rayon: ~50-100ms

The speedup comes from eliminating FFI overhead and letting Rust's parallel I/O do what it does best.
